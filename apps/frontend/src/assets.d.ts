// Bun's bundler turns image and audio imports into served asset URLs; these
// declarations give those imports a type. bun-types does not ship them.
declare module "*.png" {
  const url: string;
  export default url;
}
declare module "*.jpg" {
  const url: string;
  export default url;
}
declare module "*.jpeg" {
  const url: string;
  export default url;
}
declare module "*.webp" {
  const url: string;
  export default url;
}
declare module "*.wav" {
  const url: string;
  export default url;
}
