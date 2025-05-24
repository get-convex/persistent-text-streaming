import { type ClassValue, clsx } from "clsx";
import { useState, useLayoutEffect } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function useWindowSize() {
  const [size, setSize] = useState([0, 0]);
  useLayoutEffect(() => {
    function updateSize() {
      setSize([window.innerWidth, window.innerHeight]);
    }
    window.addEventListener("resize", updateSize);
    updateSize();
    return () => window.removeEventListener("resize", updateSize);
  }, []);
  return size;
}
export function getConvexSiteUrl() {
  let convexSiteUrl;
  if (import.meta.env.VITE_CONVEX_URL.includes(".cloud")) {
    convexSiteUrl = import.meta.env.VITE_CONVEX_URL.replace(
      /\.cloud$/,
      ".site"
    );
  } else {
    const url = new URL(import.meta.env.VITE_CONVEX_URL);
    url.port = String(Number(url.port) + 1);
    convexSiteUrl = url.toString();
  }
  if (convexSiteUrl.endsWith("/")) {
    convexSiteUrl = convexSiteUrl.slice(0, -1);
  }
  return convexSiteUrl;
}
