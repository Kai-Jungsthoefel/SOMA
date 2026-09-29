"""Phase 0, Punkt 5: Welche DLLs zieht OCP transitiv wirklich? (PE-Importtabelle)"""
import sys, os, pefile, glob

sp = sys.argv[1]
pyd = glob.glob(os.path.join(sp, "OCP", "OCP*.pyd"))[0]
dirs = [os.path.join(sp, d) for d in ("cadquery_ocp.libs", "vtk.libs")]
index = {}
for d in dirs:
    for f in os.listdir(d):
        index[f.lower()] = os.path.join(d, f)

needed, todo = set(), [pyd]
while todo:
    cur = todo.pop()
    pe = pefile.PE(cur, fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"]])
    for imp in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []):
        n = imp.dll.decode().lower()
        if n in index and n not in needed:
            needed.add(n)
            todo.append(index[n])
    pe.close()

for d in dirs:
    allf = os.listdir(d)
    tot = sum(os.path.getsize(os.path.join(d, f)) for f in allf)
    use = [f for f in allf if f.lower() in needed]
    usz = sum(os.path.getsize(os.path.join(d, f)) for f in use)
    print(f"{os.path.basename(d)}: {len(use)}/{len(allf)} DLLs benoetigt, {usz/1e6:.1f} von {tot/1e6:.1f} MB")
