"""Phase 0, Punkt 5: Umgebung kopieren, nicht geladene VTK-/OCP-DLLs loeschen, Smoke-Test wiederholen.
Aufruf: python prune_test.py <venv-quelle> <venv-ziel>   (mit dem Python der Quelle-venv ausfuehren fuer 'measure')
"""
import os, sys, shutil, subprocess, json

def measure(sp):
    """Im Ziel-Interpreter: Workload ausfuehren und geladene Module ausgeben (per ctypes/psapi)."""
    import ctypes, ctypes.wintypes as wt
    import runpy
    runpy.run_path(os.path.join(os.path.dirname(__file__), "smoke_env.py"), run_name="__main__")
    # weitere Workloads, die spaeter gebraucht werden
    import cadquery as cq
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    cq.Workplane().box(1,1,1).val().tessellate(0.1)
    psapi = ctypes.WinDLL("psapi"); k32 = ctypes.WinDLL("kernel32")
    k32.GetCurrentProcess.restype = wt.HANDLE
    psapi.EnumProcessModules.argtypes = [wt.HANDLE, ctypes.POINTER(wt.HMODULE), wt.DWORD, ctypes.POINTER(wt.DWORD)]
    psapi.EnumProcessModules.restype = wt.BOOL
    psapi.GetModuleFileNameExW.argtypes = [wt.HANDLE, wt.HMODULE, wt.LPWSTR, wt.DWORD]
    h = k32.GetCurrentProcess()
    arr = (wt.HMODULE * 4096)(); need = wt.DWORD()
    ok = psapi.EnumProcessModules(h, arr, ctypes.sizeof(arr), ctypes.byref(need))
    assert ok, "EnumProcessModules fehlgeschlagen"
    out = []
    buf = ctypes.create_unicode_buffer(1024)
    for i in range(need.value // ctypes.sizeof(wt.HMODULE)):
        psapi.GetModuleFileNameExW(h, arr[i], buf, 1024)
        out.append(buf.value)
    print("LOADED::" + json.dumps(out))

if __name__ == "__main__":
    if sys.argv[1] == "measure":
        measure(sys.argv[2]); sys.exit()
    src, dst = sys.argv[1], sys.argv[2]
    py = os.path.join(src, "Scripts", "python.exe")
    res = subprocess.run([py, __file__, "measure", src], capture_output=True, text=True)
    line = [l for l in res.stdout.splitlines() if l.startswith("LOADED::")][0]
    norm = lambda p: os.path.normcase(os.path.normpath(p))
    loaded = {norm(p) for p in json.loads(line[8:])}
    if os.path.exists(dst): shutil.rmtree(dst)
    shutil.copytree(src, dst)
    sp_src = os.path.join(src, "Lib", "site-packages"); sp_dst = os.path.join(dst, "Lib", "site-packages")
    freed = 0; kept = 0
    for d in ("vtk.libs", "cadquery_ocp.libs"):
        for f in os.listdir(os.path.join(sp_src, d)):
            if norm(os.path.join(sp_src, d, f)) not in loaded:
                p = os.path.join(sp_dst, d, f); freed += os.path.getsize(p); os.remove(p)
            else: kept += 1
    print(f"geloescht: {freed/1e6:.1f} MB, behalten: {kept} DLLs")
