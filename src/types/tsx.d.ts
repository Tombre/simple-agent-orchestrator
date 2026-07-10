declare module "tsx/esm/api" {
  export function tsImport(path: string, parentUrl: string): Promise<unknown>;
  export function register(): () => void;
}
