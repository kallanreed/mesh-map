import requests

HOST = "https://mesh-map-89j.pages.dev"

def consolidate():
  try:
    resp = requests.get(HOST + "/consolidate")
    resp.raise_for_status()
    data = resp.json()
    print(f"Consolidate returned {data}, response: {resp.status_code}")
  except requests.RequestException as e:
      print(f"Consolidate failed:{e}")


def clean_up():
  try:
    resp = requests.get(HOST + "/clean-up?op=repeaters")
    resp.raise_for_status()
    data = resp.json()
    print(f"Clean-up returned {data}, response: {resp.status_code}")
  except requests.RequestException as e:
      print(f"Clean-up failed:{e}")


def main():
  consolidate()
  clean_up()


if __name__ == "__main__":
  main()
