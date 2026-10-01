export function checkoutRoot(from: string): string;
export function besideCheckout(from: string, ...segments: string[]): string;
export function workspacePackage(from: string, name: string): string | null;
export function productCheckout(from: string, packageName: string, repositoryName: string): string;
