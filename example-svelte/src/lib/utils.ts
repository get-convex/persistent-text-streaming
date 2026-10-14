// Keeps relative, http(s), and mailto links and drops every other scheme,
// such as `javascript:`. Similar to react-markdown's default URL transform,
// which also allows a few more schemes and applies to images too.
export function safeHref(href: string) {
  const scheme = /^([^:/?#]+):/.exec(href)?.[1];
  return !scheme || /^(https?|mailto)$/i.test(scheme) ? href : undefined;
}

export function getConvexSiteUrl() {
  let convexSiteUrl;
  if (import.meta.env.VITE_CONVEX_URL.includes(".cloud")) {
    convexSiteUrl = import.meta.env.VITE_CONVEX_URL.replace(
      /\.cloud$/,
      ".site",
    );
  } else {
    const url = new URL(import.meta.env.VITE_CONVEX_URL);
    url.port = String(Number(url.port) + 1);
    convexSiteUrl = url.toString();
  }
  return convexSiteUrl;
}
