import sounddevice as sd
import json

devices = sd.query_devices()
print(json.dumps([dict(d) for d in devices], indent=2, ensure_ascii=False))
