// SOMA's own extension for pi (SOMA AI, app/src/main/somaai.ts). pi loads it at start with -e.
//
// SOMA starts pi with the Electron of the app as plain Node (ELECTRON_RUN_AS_NODE=1), so nobody has to install Node.
// The commands pi runs inherit the environment: an Electron app started from there (another program, `soma render`
// going through a browser) would also start as plain Node. So the variable goes away as soon as pi is up.
export default function soma(): void {
  delete process.env.ELECTRON_RUN_AS_NODE;
}
