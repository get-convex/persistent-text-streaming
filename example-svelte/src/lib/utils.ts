import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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

