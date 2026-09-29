import sys, json, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import cadide_proto
r = cadide_proto.build(sys.argv[1] if len(sys.argv) > 1 else "example")
r.pop("shapes")
print(json.dumps(r, indent=1))
