import json
import unittest

import importlib
wd = importlib.import_module('wardrive-mqtt')

class TestObserverConfig(unittest.TestCase):
  def test_passing_invalid_config_throws(self):
    config = json.loads('{}')
    with self.assertRaises(RuntimeError):
      wd.get_observers_map(config)


  def test_passing_mesh_observers(self):
    config = json.loads('''
      {
        "mesh_observers": [
          {
            "mesh_name": "A",
            "observers": ["R1", "R2"]
          },
          {
            "mesh_name": "B",
            "observers": ["R3"]
          }
        ]
      }
    ''')
    repeaters = wd.get_observers_map(config)
    self.assertEqual(len(repeaters), 3)
    self.assertEqual(repeaters['R1']['mesh'], 'A')
    self.assertEqual(repeaters['R2']['mesh'], 'A')
    self.assertEqual(repeaters['R3']['mesh'], 'B')


  def test_passing_watched_observers(self):
    config = json.loads('''
      {
        "watched_observers": ["R1", "R2"]
      }
    ''')
    repeaters = wd.get_observers_map(config)
    self.assertEqual(len(repeaters), 2)
    self.assertEqual(repeaters['R1']['mesh'], None)
    self.assertEqual(repeaters['R2']['mesh'], None)


  def test_passing_mesh_and_watched(self):
    config = json.loads('''
      {
        "mesh_observers": [
          {
            "mesh_name": "A",
            "observers": ["R1", "R2"]
          }
        ],    
        "watched_observers": ["W1", "W2"]
      }
    ''')
    # NB: Prefer mesh_observers in config.
    repeaters = wd.get_observers_map(config)
    self.assertEqual(len(repeaters), 2)
    self.assertEqual(repeaters['R1']['mesh'], 'A')
    self.assertEqual(repeaters['R2']['mesh'], 'A')
    self.assertIsNone(repeaters.get('W1'))


  def test_get_packet_history_returns_history_per_mesh(self):
    packet_type = '5'
    hist1 = wd.get_packet_history('M1', packet_type)
    self.assertIsNotNone(hist1)
    hist1.append(123)
    hist1 = wd.get_packet_history('M1', packet_type)
    self.assertIn(123, hist1)

    hist2 = wd.get_packet_history(None, packet_type)
    self.assertIsNotNone(hist2)
    self.assertNotIn(123, hist2)
    hist2.append(456)
    self.assertNotIn(456, hist1)


  def test_get_packet_history_returns_same_for_adverts(self):
    packet_type = '4'
    hist1 = wd.get_packet_history('M1', packet_type)
    self.assertIsNotNone(hist1)
    hist1.append(123)
    hist1 = wd.get_packet_history('M1', packet_type)
    self.assertIn(123, hist1)

    hist2 = wd.get_packet_history(None, packet_type)
    self.assertIsNotNone(hist2)
    self.assertIn(123, hist2)
    hist2.append(456)
    self.assertIn(456, hist1)


if __name__ == '__main__':
  unittest.main()