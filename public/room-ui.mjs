// Both roles use exactly the same chat renderer, DOM and 3D house.
await Promise.all([import('./assistant.js'), import('./house.js')]);
if (document.body.dataset.role !== 'guest')
  await Promise.all([import('./task-screen.js'), import('./share.js')]);
