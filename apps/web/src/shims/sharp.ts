// Browser stand-in for sharp (Architect import-core only uses it under Node).
export default function sharp(): never { throw new Error('sharp is not available in the browser'); }
