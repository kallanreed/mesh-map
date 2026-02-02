import io
import json
import os
import paho.mqtt.client as mqtt
import re
import requests
import socket
import ssl
import threading
import time

from collections import deque
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from haversine import haversine, Unit
from queue import Queue, Full

# Globals
CONFIG = json.load(open('config.json'))
CENTER_POSITION = tuple(CONFIG['center_position'])
VALID_DIST = CONFIG['valid_dist']
CHANNEL_HASH = CONFIG['channel_hash']
CHANNEL_SECRET = bytes.fromhex(CONFIG['channel_secret'])
SESSION = requests.Session()
WORK_Q = Queue(maxsize=2000)

SERVICE_HOST = CONFIG['service_host']
ADD_REPEATER_URL = '/put-repeater'
ADD_SAMPLE_URL = '/put-sample'

STATS = {
  'last_connect': 0,
  'last_message': 0,
  'last_pingrsp': 0,
  'last_log_stats': 0,
  'received_count': 0,
  'processed_count': 0,
  'bad_length': 0,
}

OBSERVERS = {}
PACKET_HISTORY = {}
COORD_PAIR = re.compile(
  r"""
  (?P<lat>[+-]?\d+(?:\.\d+)?)        # latitude number
  \s*,?\s+                           # whitespace (optional comma)
  (?P<lon>[+-]?\d+(?:\.\d+)?)        # longitude number
  (\s+(?P<ignored>[0-9a-fA-F]{2}))?  # optional ignored repeater id
  """,
  re.VERBOSE,
)

# Initialize the watched observers based on the config.
def init_observers_map():
  global OBSERVERS
  OBSERVERS = get_observers_map(CONFIG)

def get_observers_map(config):
  observers = {}
  mesh_observers = config.get('mesh_observers')
  if (mesh_observers is not None):
    print('Using "mesh_observers" from config')
    for mesh in mesh_observers:
      for o in mesh['observers']:
        observers[o] = { 'mesh': mesh['mesh_name'] }
    return observers

  watched_observers = config.get('watched_observers')
  if watched_observers is None:
    raise RuntimeError('Config is missing either mesh_observers or watched_observers.')
  
  for o in watched_observers:
    observers[o] = { 'mesh': None }
  return observers


# Logs current stats.
def log_stats():
  now = time.monotonic()
  stats = {
    'uptime': int(now - STATS['last_connect']),
    'since_last_message': int(now - STATS['last_message']),
    #'since_last_pingresp': int(now - STATS['last_pingresp']),
    'received': STATS['received_count'],
    'processed': STATS['processed_count'],
    'queue_size': WORK_Q.qsize(),
    'bad_length': STATS['bad_length']
  }
  print(f'STATS: {stats}')
  STATS['last_log_stats'] = now


# Resets the stats tracking.
def reset_stats():
  STATS['last_connect'] = 0
  STATS['last_message'] = 0
  STATS['last_pingresp'] = 0
  STATS['last_log_stats'] = 0
  STATS['received_count'] = 0
  STATS['processed_count'] = 0
  STATS['bad_length'] = 0


# Get the deque history for the specified mesh and packet type.
def get_packet_history(mesh: str, packet_type: str):
  # Use the same 'None' history for all ADVERT packets
  # because they are not getting tracked per-mesh.
  key = None if packet_type == '4' else mesh
  history = PACKET_HISTORY.get(key)
  if history is None:
    history = PACKET_HISTORY[key] = deque(maxlen=100)
  return history


# Returns true if the specified location is valid for upload.
def is_valid_location(lat: float, lon: float):
  if (not (-90 <= lat <= 90 and -180 <= lon <= 180)):
    print(f'Invalid position data {(lat, lon)}')
    return False

  distance = haversine(CENTER_POSITION, (lat, lon), unit=Unit.MILES) 
  if (distance > VALID_DIST):
    print(f'{(lat, lon)} distance {distance} exceeds max distance')
    return False

  return True


# Sends data to the specified url with error logging.
def post_to_service(url, data):
  try:
    resp = SESSION.post(url, json=data, timeout=5)
    resp.raise_for_status()
    print(f'Sent {data} response: {resp.status_code}')
  except requests.RequestException as e:
      print(f'POST {data} failed:{e}')


# Uploads an observed sample to the service.
def upload_sample(lat: float, lon: float, mesh: str, path: list[str]):
  payload = {
    'lat': lat,
    'lon': lon,
    'path': path,
    'observed': True
  }

  if mesh is not None:
    payload['mesh'] = mesh

  url = SERVICE_HOST + ADD_SAMPLE_URL
  post_to_service(url, payload)


# Uploads a repeater update to the service.
def upload_repeater(id: str, name: str, lat: float, lon: float):
  payload = {
    'id': id,
    'name': name,
    'lat': lat,
    'lon': lon
  }
  url = SERVICE_HOST + ADD_REPEATER_URL
  post_to_service(url, payload)


# Decrypts a payload using the given secret.
def decrypt(secret: bytes, encrypted: bytes) -> bytes:
  cipher = Cipher(algorithms.AES(secret), modes.ECB())
  decryptor = cipher.decryptor()
  return decryptor.update(encrypted) + decryptor.finalize()


# Decodes UTF8 characters and removes null padding bytes.
def to_utf8(data: bytes) -> str:
  return data.decode('utf-8', 'ignore').replace('\0', '')


# Builds a MeshCore packet from raw bytes.
def make_packet(raw: str):
  # see https://github.com/meshcore-dev/MeshCore/blob/9405e8bee35195866ad1557be4af5f0c140b6ad1/src/Packet.h
  buf = io.BytesIO(bytes.fromhex(raw))
  header = buf.read(1)[0]
  route_type = header & 0x3
  packet_type = header >> 2 & 0xF
  transport_codes = [0, 0]

  # Read transport codes from transport route types.
  if route_type in [0, 3]:
    transport_codes[0] = int.from_bytes(buf.read(2), byteorder='little')
    transport_codes[1] = int.from_bytes(buf.read(2), byteorder='little')

  path_len = buf.read(1)[0]
  path = buf.read(path_len).hex()
  payload = buf.read()
  return {
    'transport_codes': transport_codes,
    'route_type': route_type,
    'packet_type': packet_type,
    'path_len': path_len,
    'path': path,
    'payload': payload
  }


# Handle an ADVERT packet.
def handle_advert(packet):
  # See https://github.com/meshcore-dev/MeshCore/blob/9405e8bee35195866ad1557be4af5f0c140b6ad1/src/Mesh.cpp#L231
  # See https://github.com/meshcore-dev/MeshCore/blob/9405e8bee35195866ad1557be4af5f0c140b6ad1/src/helpers/AdvertDataHelpers.cpp#L29
  payload = io.BytesIO(packet['payload'])

  pubkey = payload.read(32).hex()
  timestamp = int.from_bytes(payload.read(4), byteorder='little')
  signature = payload.read(64).hex()
  flags = payload.read(1)[0]
  type = flags & 0xF # ADV_TYPE_MASK

  # Only care about repeaters (2).
  if type != 2: return

  id = pubkey[0:2]
  lat = 0
  lon = 0
  name = ''

  if flags & 0x10: # ADV_LATLON_MASK
    lat = int.from_bytes(payload.read(4), byteorder='little', signed=True) / 1e6
    lon = int.from_bytes(payload.read(4), byteorder='little', signed=True) / 1e6
  if flags & 0x20: # ADV_FEAT1_MASK
    payload.read(2)
  if flags & 0x40: # ADV_FEAT2_MASK
    payload.read(2)
  if flags & 0x80: # ADV_NAME_MASK
    name = to_utf8(payload.read())

  if is_valid_location(lat, lon):
    upload_repeater(id, name, lat, lon)


# Handle a GROUP_MSG packet.
def handle_channel_msg(packet, mesh):
  # See https://github.com/meshcore-dev/MeshCore/blob/9405e8bee35195866ad1557be4af5f0c140b6ad1/src/Mesh.cpp#L206C1-L206C33
  payload = io.BytesIO(packet['payload'])
  
  channel_hash = payload.read(1).hex()
  mac = payload.read(2)
  encrypted = payload.read()
  encrypted_len = len(encrypted)
  block_size = 16

  # Encrypted data has a bad length, attempt a fixup.
  if len(encrypted) % block_size != 0:
    STATS['bad_length'] += 1
    new_encrypted_len = int(encrypted_len / block_size) * block_size
    encrypted = encrypted[:new_encrypted_len]
    if new_encrypted_len == 0:
      return

  # Not the watched channel.
  if channel_hash != CHANNEL_HASH: return

  # TODO: technically should check the HMAC here.
  data = decrypt(CHANNEL_SECRET, encrypted)

  # Data wasn't decrypted or complete.
  if len(data) <= 4: return

  plain_text = to_utf8(data[5:]).lower()
  first_repeater = packet['path'][0:2]
  match = re.search(COORD_PAIR, plain_text)

  # Not a lat/lon sample.
  if not match: return

  lat = float(match.group('lat'))
  lon = float(match.group('lon'))
  ignored = match.group('ignored')

  # First path should be ignored (mobile repeater case).
  if first_repeater == ignored:
    first_repeater = packet['path'][2:4]
    print(f'Ignoring first hop {ignored}, using {first_repeater}')

  if is_valid_location(lat, lon) and first_repeater != '':
    upload_sample(lat, lon, mesh, [first_repeater])


# Callback when the client receives a CONNACK response from the broker.
def on_connect(client, userdata, flags, reason_code, properties = None):
  reset_stats()
  STATS['last_connect'] = time.monotonic()

  if reason_code == 0:
    print('Connected to MQTT Broker')
    topics = list(map(lambda x: (x, 0), CONFIG['mqtt_topics']))
    print(f'Subscribing to {topics}')
    client.subscribe(topics)
  else:
    print(f'Failed to connect, return code {reason_code}', flush = True)


# Callback when the client is disconnected from the broker.
def on_disconnect(client, userdata, flags, reason_code, properties = None):
  if reason_code != 0:
    print(f'MQTT disconnected unexpectedly, rc={reason_code}', flush = True)
    log_stats()


# Callback when a PUBLISH message is received from the broker.
def on_message(client, userdata, msg):
  try:
    STATS['last_message'] = time.monotonic()
    STATS['received_count'] += 1
    WORK_Q.put_nowait(msg.payload)
  except Full:
    print('Queue full; dropping message')


# Callback for logging.
def on_log(client, userdata, level, buf):
  if 'Received PUBLISH' in buf:
    return
  if 'Sending PINGREQ' in buf:
      log_stats()
  if 'Received PINGRESP' in buf:
      STATS['last_pingresp'] = time.monotonic()
  print(f'PAHO: {buf}')


# Handles payload on background thread.
def process_payload(payload):
  data = {}
  
  try:
    data = json.loads(payload.decode())

    # Is this one of the 'authoritative' observers in the region?
    observer_info = OBSERVERS.get(data['origin'])
    if observer_info is None: return

    mesh = observer_info['mesh']

    # Is this an advert (4) or group message (5)?
    packet_type = data['packet_type']
    if packet_type not in ['4', '5']: return

    # Get the history instance for this mesh/packet_type.
    history = get_packet_history(mesh, packet_type)

    # Don't reprocess packets for now. Might be worth
    # extracting other paths at some point. That requires
    # stashing packets and processing them all at once.
    packet_hash = data.get('hash')
    if (packet_hash is None or packet_hash in history): return

    # Parse the outer packet.
    packet = make_packet(data['raw'])

    # Messages won't have the observer in the path.
    # Append the observer's id to the path.
    packet['path'] += data['origin_id'][0:2].lower()
    packet['path_len'] += 2

    # Handle the app-specific payload.
    if packet_type == '4':
      handle_advert(packet)
    elif packet_type == '5':
      handle_channel_msg(packet, mesh)

    # All done, mark this hash 'seen'.
    history.append(packet_hash)
  except Exception as e:
    print(f'Error handling message: {e}')
    print(f'>> {data}')


# Processes the WORK_Q items.
def queue_processor():
  while True:
    # Log stats every 10 minutes.
    if (time.monotonic() - STATS['last_log_stats']) > 600:
      log_stats()

    payload = WORK_Q.get()
    try:
      process_payload(payload)
      STATS['processed_count'] += 1
    except Exception as e:
      print(f'Error in queue_processor: {e}')
    finally:
      WORK_Q.task_done()
      time.sleep(0.001)  # yield GIL to other threads


def main():
  init_observers_map()

  # Initialize the MQTT client.
  client = mqtt.Client(
    mqtt.CallbackAPIVersion.VERSION2,
    transport='websockets',
    client_id=None,
    clean_session=True,
    protocol=mqtt.MQTTv311)

  client.username_pw_set(
    CONFIG['mqtt_username'],
    CONFIG['mqtt_password'])

  client.tls_set(cert_reqs=ssl.CERT_REQUIRED)
  client.tls_insecure_set(False)
  client.reconnect_delay_set(min_delay=1, max_delay=60)

  client.on_connect = on_connect
  client.on_disconnect = on_disconnect
  client.on_message = on_message
  #client.on_log = on_log

  try:
    print('Starting worker thread...')
    threading.Thread(target=queue_processor, daemon=True).start()
    print(f"Connecting to {CONFIG['mqtt_host']}:{CONFIG['mqtt_port']}")
    client.connect(CONFIG['mqtt_host'], CONFIG['mqtt_port'], 30)
    client.loop_forever(retry_first_connection=True)
  except Exception as e:
    print(f'An error occurred: {e}')


if __name__ == '__main__':
  main()