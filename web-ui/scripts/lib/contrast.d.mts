export const TOKENS_DIR: string
export const BGS: string[]
export function readToken(file: string): string
export const THEMES: string[]
export const TONE: Record<string, 'd' | 'l'>
export const NEED: Record<string, number>
export const CONTROL_NEED: Record<string, number>
export interface ContrastRow { theme: string; token: string; worst: number; need: number; ok: boolean }
export interface LoadedTheme { base: Record<string, string>; themes: Record<string, Record<string, string>> }
export function hex(value: string): [number, number, number] | null
export function toHex(rgb: number[]): string
export function contrast(a: number[], b: number[]): number
export function push(rgb: number[], towardWhite: boolean, amount: number): number[]
export function loadTheme(files?: string[]): LoadedTheme
export function resolve(value: string | undefined, ...scopes: Record<string, string>[]): string | undefined
export function accentTexts(base: Record<string, string>): Record<string, { d: string; l: string }>
export function matrix(loaded?: LoadedTheme): ContrastRow[]
export const TINT: number
export function tintBackgrounds(theme: string, loaded?: LoadedTheme): Record<string, number[][]>
export function tintMatrix(loaded?: LoadedTheme): ContrastRow[]
