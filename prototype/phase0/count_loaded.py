"""Zaehlt nach verschiedenen Importen, wie viele DLLs aus vtk.libs / cadquery_ocp.libs geladen sind."""
import ctypes, ctypes.wintypes as wt, os, sys, importlib

def loaded():
    psapi = ctypes.WinDLL("psapi"); k32 = ctypes.WinDLL("kernel32")
    k32.GetCurrentProcess.restype = wt.HANDLE
    psapi.EnumProcessModules.argtypes = [wt.HANDLE, ctypes.POINTER(wt.HMODULE), wt.DWORD, ctypes.POINTER(wt.DWORD)]
    psapi.GetModuleFileNameExW.argtypes = [wt.HANDLE, wt.HMODULE, wt.LPWSTR, wt.DWORD]
    h = k32.GetCurrentProcess(); arr = (wt.HMODULE * 4096)(); need = wt.DWORD()
    psapi.EnumProcessModules(h, arr, ctypes.sizeof(arr), ctypes.byref(need))
    buf = ctypes.create_unicode_buffer(1024); out = []
    for i in range(need.value // ctypes.sizeof(wt.HMODULE)):
        psapi.GetModuleFileNameExW(h, arr[i], buf, 1024); out.append(buf.value.lower())
    return out

def report(label):
    l = loaded()
    v = [x for x in l if "vtk.libs" in x]; o = [x for x in l if "cadquery_ocp.libs" in x]
    mb = sum(os.path.getsize(x) for x in v + o) / 1e6
    print(f"{label:38s} vtk.libs {len(v):3d}  ocp.libs {len(o):2d}  = {mb:6.1f} MB")

report("Start")
import OCP; report("import OCP")
from OCP.STEPCAFControl import STEPCAFControl_Writer; from OCP.XCAFDoc import XCAFDoc_DocumentTool; report("+ STEPCAF/XCAF (OCP)")
import cadquery; report("+ import cadquery")
