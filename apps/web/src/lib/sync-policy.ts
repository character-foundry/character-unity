export const opaqueSyncNotice = 'Not listed for remote sync: opaque RisuAI module (module.risum). The current signed-sync profile cannot transfer this file. The complete publication, same-hub forks and original stay available here.';
export const remoteListingPolicy = 'Remote listings omit whole publications with opaque RisuAI modules (module.risum). Their complete files remain on the source hub; no module is stripped to make a card transferable.';
export const hasOpaqueModule = (assets: readonly { path: string }[]) => assets.some((asset) => asset.path === 'module.risum');
