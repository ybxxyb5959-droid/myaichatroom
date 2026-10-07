export function isLocalNavigation(value, origin) {
  try { return new URL(value).origin === origin; } catch { return false; }
}

export function isExternalWebLink(value, origin) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && url.origin !== origin && !url.username && !url.password;
  } catch { return false; }
}
