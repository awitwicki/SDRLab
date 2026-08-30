declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}

declare module '*?worker&url' {
  const src: string;
  export default src;
}
