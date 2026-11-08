export function readText(relative: string): string
export function pngInfo(relative: string): { width: number; height: number; colorType: number }
export function runInSandbox(code: string, sandbox: Record<string, unknown>): void
