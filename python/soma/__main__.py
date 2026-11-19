from .cli import main

# Guarded: worker processes for meshing (parmesh.py) are spawned and must never run the command line again
if __name__ == "__main__":
    raise SystemExit(main())
