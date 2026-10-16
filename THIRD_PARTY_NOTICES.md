# Third-party notices

SOMA itself is licensed under the GNU General Public License, version 3 or (at your option) any later version
(`GPL-3.0-or-later`, see `LICENSE`), with an additional permission for the models you create (`MODEL-EXCEPTION.md`).

The SOMA installers (Windows, macOS, Linux) also contain the third-party components listed below. Each keeps its own
license. All of them are free software or open source and may be distributed together with SOMA. Points that need a
remark are listed under [Notes](#notes).

Versions are those of SOMA 0.6.2. The exact list of Python packages in an installed copy is in
`resources/python/SOMA-RUNTIME.txt`, the CalculiX packages in `resources/python/ccx/PACKAGES.txt`. In the app,
Settings > About shows the main components with version and license.

## Where to find the license texts

Paths are relative to the installation folder (macOS: `SOMA.app/Contents`, where `resources` is `Resources`).

| What | Location |
|---|---|
| SOMA | `resources/LICENSE.txt`, `resources/MODEL-EXCEPTION.md`, this file in `resources/THIRD_PARTY_NOTICES.md` |
| Electron, Chromium, Node.js | `LICENSE.electron.txt`, `LICENSES.chromium.html` (next to the program; macOS: in the app bundle) |
| npm packages bundled into the app | `resources/app/dist/licenses/<package>@<version>/` |
| pdf.js data (fonts, decoders) | `resources/app/dist/renderer/pdfjs/LICENSE`, `.../pdfjs/standard_fonts/LICENSE_*`, `.../pdfjs/wasm/LICENSE_*` |
| Git (dugite) | `resources/app/node_modules/dugite/git/LICENSE.txt` and the `share/licenses` folders below it |
| node-pty | `resources/app/node_modules/node-pty/LICENSE`, winpty in `resources/app/dist/licenses/node-pty__winpty/` |
| Python | `resources/python/LICENSE.txt` (Windows) or `resources/python/lib/python3.12/LICENSE.txt` |
| Python packages | `resources/python/.../site-packages/<package>.dist-info/` (`LICENSE*`, `licenses/`), some inside the package folder |
| gmsh | `resources/python/share/doc/gmsh/LICENSE.txt` |
| CalculiX and its libraries | `resources/python/ccx/licenses/<package>/` |
| Fastener tables | `resources/python/.../site-packages/soma/data/fasteners/LICENSE-bd_warehouse.txt` |

## Source code

SOMA: the source of each release is the tagged commit `vX.Y.Z` at https://github.com/Kai-Jungsthoefel/SOMA.

The corresponding source of the components under the GPL or LGPL (and of the other components) is available from the
upstream projects at the URLs given below, for the version listed. If a link no longer leads to the exact version,
open an issue at https://github.com/Kai-Jungsthoefel/SOMA/issues and the source will be provided.

## Desktop app: Electron and npm packages

The app is bundled with esbuild. The packages are compiled into `resources/app/dist/`, except dugite and node-pty, which
ship as their package folders.

| Component | Version | License (SPDX) | Upstream | GPL-3.0+ compatible |
|---|---|---|---|---|
| Electron (incl. Chromium, Node.js, V8, FFmpeg) | 44.4.5 | MIT; Chromium: BSD-3-Clause and many others, see `LICENSES.chromium.html` | https://github.com/electron/electron | yes |
| @codemirror/autocomplete, commands, lang-css, lang-html, lang-javascript, lang-markdown, lang-python, language, lint, search, state, view | 6.x (see `dist/licenses`) | MIT | https://github.com/codemirror | yes |
| @lezer/common, css, highlight, html, javascript, lr, markdown, python | 1.x | MIT | https://github.com/lezer-parser | yes |
| @marijn/find-cluster-break, crelt, style-mod, w3c-keyname | 1.0.4, 1.0.7, 4.1.4, 2.2.8 | MIT | https://github.com/marijnh | yes |
| @xterm/xterm | 6.0.0 | MIT | https://github.com/xtermjs/xterm.js | yes |
| @xterm/addon-fit, @xterm/addon-webgl | 0.11.0, 0.19.0 | MIT | https://github.com/xtermjs/xterm.js | yes |
| three | 0.180.0 | MIT | https://github.com/mrdoob/three.js | yes |
| three-mesh-bvh | 0.9.15 | MIT | https://github.com/gkjohnson/three-mesh-bvh | yes |
| marked | 18.1.0 | MIT | https://github.com/markedjs/marked | yes |
| mediabunny | 1.61.3 | MPL-2.0 | https://github.com/Vanilagy/mediabunny | yes (MPL-2.0 section 3.3) |
| pdfjs-dist (pdf.js) | 6.4.299 | Apache-2.0 | https://github.com/mozilla/pdf.js | yes |
| yauzl, yazl | 3.4.0, 3.3.1 | MIT | https://github.com/thejoshwolfe/yauzl, https://github.com/thejoshwolfe/yazl | yes |
| buffer-crc32, pend | 1.0.0, 1.2.0 | MIT | https://github.com/brianloveswords/buffer-crc32, https://github.com/andrewrk/node-pend | yes |
| node-pty | 1.1.0 | MIT | https://github.com/microsoft/node-pty | yes |
| winpty (in node-pty, Windows) | as in node-pty 1.1.0 | MIT | https://github.com/rprichard/winpty | yes |
| ConPTY / OpenConsole (in node-pty, Windows) | as in node-pty 1.1.0 | MIT | https://github.com/microsoft/terminal | yes |
| dugite | 3.2.3 | MIT | https://github.com/desktop/dugite | yes |

`dist/licenses` also holds the license texts of packages that npm installs as dependencies of the above but that are not
needed at run time (for example the download helpers of dugite).

## Bundled Python runtime

Python 3.12.15 from python-build-standalone (installed with uv), plus the packages from
`python/requirements-base.txt` and `soma` itself. Package licenses as stated in their metadata, with the libraries the
wheels bundle where relevant.

| Component | Version | License (SPDX) | Upstream | GPL-3.0+ compatible |
|---|---|---|---|---|
| CPython (python-build-standalone) | 3.12.15 | PSF-2.0; bundles OpenSSL (Apache-2.0), libffi (MIT), SQLite (public domain), zlib, bzip2, xz, expat, mpdecimal, Tcl/Tk (TCL) | https://www.python.org, https://github.com/astral-sh/python-build-standalone | yes |
| cadquery | 2.8.0 | Apache-2.0 | https://github.com/CadQuery/cadquery | yes |
| cadquery-ocp, cadquery-ocp-proxy (OCP bindings) | 7.9.3.1.1 | Apache-2.0 | https://github.com/CadQuery/OCP | yes |
| Open CASCADE Technology (in cadquery-ocp) | 7.9.3 | LGPL-2.1-only WITH OCCT-exception-1.0 | https://github.com/Open-Cascade-SAS/OCCT | yes |
| Libraries in cadquery-ocp: FreeImage | 3.x | GPL-2.0-only OR GPL-3.0-only OR FreeImage | https://freeimage.sourceforge.io | yes (under GPL-3.0) |
| Libraries in cadquery-ocp: FreeType | 2.x | FTL OR GPL-2.0-or-later | https://freetype.org | yes |
| Libraries in cadquery-ocp: LibRaw | 0.x | LGPL-2.1-only OR CDDL-1.0 | https://www.libraw.org | yes (under LGPL-2.1) |
| Libraries in cadquery-ocp: OpenEXR, Imath, libjpeg, libpng, libtiff, libwebp, lcms2, Lerc, libdeflate, OpenJPEG, OpenJPH, zlib, zstd, liblzma | see wheel | BSD-3-Clause, IJG, libpng-2.0, libtiff, MIT, Apache-2.0, BSD-2-Clause, Zlib, 0BSD | conda-forge / vcpkg upstreams | yes |
| casadi | 3.8.1 | LGPL-3.0-or-later | https://github.com/casadi/casadi | yes |
| Solver plugins in casadi: Ipopt, Cbc, Clp, Cgl, Osi, CoinUtils | see casadi 3.8.1 | EPL-2.0 | https://github.com/coin-or | see note 1 |
| Solver plugins in casadi: Bonmin | see casadi 3.8.1 | EPL-1.0 | https://github.com/coin-or/Bonmin | see note 1 |
| Solver plugins in casadi: MUMPS | see casadi 3.8.1 | CeCILL-C | https://mumps-solver.org | see note 1 |
| Other libraries in casadi: SUNDIALS, HiGHS, OSQP, qpOASES, METIS, BLASFEO, HPIPM, alpaqa, fatrop, sleqp, Uno, DAQP, PIQP, ProxQP, SuperSCS, trlib, BQPD, tinyxml2, libzip, ONNX, protobuf, OpenBLAS | see casadi 3.8.1 | BSD-3-Clause, MIT, Apache-2.0, LGPL-2.1-or-later, LGPL-3.0-or-later, BSD-2-Clause, Zlib | texts in `casadi/include/licenses/` | yes |
| vtk (incl. bundled HDF5, NetCDF, PROJ, libxml2, Ogg/Theora, Viskores, OpenXR loader, ...) | 9.6.2 | BSD-3-Clause (bundled: BSD-style, MIT, Apache-2.0, Zlib, public domain) | https://vtk.org | yes |
| gmsh | 4.15.2 | GPL-2.0-or-later (with exception for Netgen, METIS, OpenCASCADE, ParaView) | https://gmsh.info | yes (under GPL-3.0) |
| numpy (incl. OpenBLAS, GCC runtime) | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0; OpenBLAS BSD-3-Clause; libgfortran GPL-3.0-or-later WITH GCC-exception-3.1 | https://numpy.org | yes |
| scipy (incl. OpenBLAS, Qhull, GCC runtime) | 1.18.1 | BSD-3-Clause (bundled: Qhull, BSD-style) | https://scipy.org | yes |
| matplotlib (incl. DejaVu and STIX fonts) | 3.11.2 | PSF-2.0-style matplotlib license; fonts Bitstream-Vera, OFL-1.1 | https://matplotlib.org | yes |
| numba | 0.67.0 | BSD-2-Clause | https://numba.pydata.org | yes |
| llvmlite (incl. LLVM) | 0.49.0 | BSD-2-Clause AND Apache-2.0 WITH LLVM-exception | https://github.com/numba/llvmlite | yes |
| pyamg | 5.3.0 | MIT | https://github.com/pyamg/pyamg | yes |
| nlopt | 2.11.0 | MIT AND LGPL-2.1-or-later | https://github.com/stevengj/nlopt | yes |
| ezdxf | 1.4.4 | MIT | https://github.com/mozman/ezdxf | yes |
| pdfplumber | 0.11.10 | MIT | https://github.com/jsvine/pdfplumber | yes |
| pdfminer.six | 20260107 | MIT | https://github.com/pdfminer/pdfminer.six | yes |
| pypdfium2 (incl. PDFium and its dependencies) | 5.14.0 | Apache-2.0 OR BSD-3-Clause; PDFium BSD-3-Clause, bundled libraries as listed in the package | https://github.com/pypdfium2-team/pypdfium2 | yes |
| pillow | 12.3.0 | MIT-CMU | https://github.com/python-pillow/Pillow | yes |
| fonttools | 4.66.0 | MIT | https://github.com/fonttools/fonttools | yes |
| contourpy | 1.4.0 | BSD-3-Clause | https://github.com/contourpy/contourpy | yes |
| cycler | 0.12.1 | BSD-3-Clause | https://github.com/matplotlib/cycler | yes |
| kiwisolver | 1.5.1 | BSD-3-Clause | https://github.com/nucleic/kiwi | yes |
| pyparsing | 3.3.3 | MIT | https://github.com/pyparsing/pyparsing | yes |
| python-dateutil | 2.9.0.post0 | Apache-2.0 AND BSD-3-Clause | https://github.com/dateutil/dateutil | yes |
| six | 1.17.0 | MIT | https://github.com/benjaminp/six | yes |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause | https://github.com/pypa/packaging | yes |
| pip (incl. vendored packages, certifi MPL-2.0) | 26.2.1 | MIT | https://github.com/pypa/pip | yes |
| multimethod | 1.12 | Apache-2.0 | https://github.com/coady/multimethod | yes |
| runtype | 0.5.3 | MIT | https://github.com/erezsh/runtype | yes |
| typing_extensions | 4.16.0 | PSF-2.0 | https://github.com/python/typing_extensions | yes |
| PyYAML | 6.0.3 | MIT | https://github.com/yaml/pyyaml | yes |
| more-itertools | 11.1.0 | MIT | https://github.com/more-itertools/more-itertools | yes |
| cryptography | 50.0.2 | Apache-2.0 OR BSD-3-Clause | https://github.com/pyca/cryptography | yes |
| cffi | 2.1.1 | MIT-0 | https://github.com/python-cffi/cffi | yes |
| pycparser | 3.11 | BSD-3-Clause | https://github.com/eliben/pycparser | yes |
| charset-normalizer | 3.5.2 | MIT | https://github.com/jawah/charset_normalizer | yes |
| idna | 3.20 | BSD-3-Clause | https://github.com/kjd/idna | yes |
| attrs | 26.1.0 | MIT | https://github.com/python-attrs/attrs | yes |
| msgpack | 1.2.3 | Apache-2.0 | https://github.com/msgpack/msgpack-python | yes |
| aiohttp (incl. llhttp) | 3.14.3 | Apache-2.0 AND MIT | https://github.com/aio-libs/aiohttp | yes |
| aiohappyeyeballs | 2.7.1 | PSF-2.0 | https://github.com/aio-libs/aiohappyeyeballs | yes |
| aiosignal, frozenlist, multidict, propcache, yarl | 1.4.0, 1.8.0, 6.9.1, 0.5.4, 1.25.1 | Apache-2.0 | https://github.com/aio-libs | yes |
| trame, trame-common, trame-components, trame-server | 4.0.0, 1.2.7, 2.5.0, 4.0.0 | Apache-2.0 | https://github.com/Kitware/trame | yes |
| trame-client, trame-vuetify (incl. Vue.js, Vuetify) | 4.1.2, 3.2.6 | MIT | https://github.com/Kitware/trame-client, https://github.com/Kitware/trame-vuetify | yes |
| trame-vtk | 2.11.17 | BSD-3-Clause | https://github.com/Kitware/trame-vtk | yes |
| wslink | 2.5.7 | BSD-3-Clause | https://github.com/Kitware/wslink | yes |
| Microsoft Visual C++ runtime (Windows: msvcp140, vcruntime140, vcomp140 in Python and in several wheels) | 14.x | Microsoft Visual C++ Redistributable license | https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist | see note 3 |
| Linux only: libGLU, libXft, libXinerama, libXcursor (copied from the build system for gmsh) | as on the build system | SGI-B-2.0, MIT | https://gitlab.freedesktop.org | yes |

## Native tools

| Component | Version | License (SPDX) | Upstream | GPL-3.0+ compatible |
|---|---|---|---|---|
| Git (dugite-native, Windows: from Git for Windows) | 2.53.0 (dugite-native v2.53.0-4) | GPL-2.0-only | https://github.com/desktop/dugite-native, https://github.com/git-for-windows/git, https://git-scm.com | yes, separate program (note 2) |
| Components of Git for Windows: MSYS2 runtime, Bash, coreutils, gawk, grep, findutils, diffutils | see `etc/package-versions.txt` | LGPL-3.0-or-later (MSYS2 runtime), GPL-3.0-or-later | https://github.com/git-for-windows, https://www.msys2.org | yes |
| Components of Git for Windows: OpenSSL, curl, OpenSSH, libssh2, PCRE2, zlib, zstd, brotli, nghttp2, expat, ncurses | see `etc/package-versions.txt` | Apache-2.0, curl, BSD-2-Clause/BSD-3-Clause, Zlib, MIT, X11 | as listed in `share/licenses` | yes |
| Git LFS, Git Credential Manager (Windows) | as in dugite-native | MIT | https://github.com/git-lfs/git-lfs, https://github.com/git-ecosystem/git-credential-manager | yes |
| CalculiX ccx (from conda-forge) | 2.23 | GPL-2.0-or-later | http://www.calculix.de, https://github.com/conda-forge/calculix-feedstock | yes (under GPL-3.0) |
| ARPACK-NG | 3.9.1 | BSD-3-Clause | https://github.com/opencollab/arpack-ng | yes |
| OpenBLAS (libblas, liblapack, libopenblas) | 0.3.34 | BSD-3-Clause | https://github.com/OpenMathLib/OpenBLAS | yes |
| GCC runtime (libgcc, libgfortran, libgomp, libquadmath, libstdc++) | 16.2.0 | GPL-3.0-only WITH GCC-exception-3.1 | https://gcc.gnu.org | yes |
| winpthreads (Windows) | 12.0.0 | MIT AND BSD-3-Clause-Clear | https://www.mingw-w64.org | yes |
| Microsoft Visual C++ runtime, UCRT (Windows, from conda-forge) | 14.51 | Microsoft Visual C++ Redistributable license | https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist | see note 3 |
| gmsh | see Python runtime | | | |

## Assets

| Component | Version | License (SPDX) | Upstream | GPL-3.0+ compatible |
|---|---|---|---|---|
| IBM Plex Sans, IBM Plex Mono (via @fontsource) | 5.3.0 | OFL-1.1 | https://github.com/IBM/plex, https://github.com/fontsource/font-files | yes |
| pdf.js standard fonts: Foxit fonts | as in pdfjs-dist 6.4.299 | BSD-3-Clause (PDFium) | https://github.com/mozilla/pdf.js | yes |
| pdf.js standard fonts: Liberation fonts | as in pdfjs-dist 6.4.299 | OFL-1.1 | https://github.com/liberationfonts | yes |
| pdf.js character maps (cmaps) | as in pdfjs-dist 6.4.299 | BSD-3-Clause (Adobe) | https://github.com/adobe-type-tools/cmap-resources | yes |
| pdf.js decoders: OpenJPEG, JBIG2 (PDFium), qcms, QuickJS (WebAssembly) | as in pdfjs-dist 6.4.299 | BSD-2-Clause, BSD-3-Clause, MIT | https://github.com/mozilla/pdf.js | yes |
| Fastener dimension tables (from bd_warehouse) | 0.3.0, commit eed2da1 | Apache-2.0 | https://github.com/gumyr/bd_warehouse | yes |

"As CadQuery script" copies the fastener tables into exported scripts that use standard parts, with a note on their
origin and license. The compatibility code around them (`python/soma/cqruntime.py`, `python/soma/fasteners.py`) is
SOMA's own work and also available under the Apache License 2.0.

The SOMA icon and the interface symbols are SOMA's own work.

## Notes

1. **Solver plugins in casadi (EPL, CeCILL-C).** casadi is a dependency of CadQuery (constraint solver for
   assemblies). Its wheel ships optional solver plugins under the Eclipse Public License (Ipopt, the COIN-OR libraries,
   Bonmin) and under CeCILL-C (MUMPS). The EPL is not compatible with the GPL. SOMA does not link these libraries and
   does not call them; casadi loads them only when a model solves assembly constraints with CadQuery. They are
   distributed as separate libraries next to SOMA, under their own licenses, which are included in
   `casadi/include/licenses/`.
2. **Git is GPL-2.0-only.** SOMA runs Git as a separate program and does not link it, so the two licenses do not
   interact. Git is distributed under GPL-2.0-only; its source is available at the URLs above.
3. **Microsoft Visual C++ runtime.** On Windows, Python, several wheels and CalculiX bring the Microsoft C++ runtime
   DLLs, which Microsoft allows to be redistributed with applications. They are not free software; they are treated as
   system libraries in the sense of section 1 of the GPL-3.0, which does not require their source.
