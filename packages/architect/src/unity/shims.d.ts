// import-core lazy-loads sharp only under Node; the browser build never resolves it.
declare module 'sharp' {
  const sharp: (input?: unknown) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  export default sharp;
}
