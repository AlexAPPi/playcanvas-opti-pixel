export interface IRenderItem {
    depth: number;
}

export function sortOpaque(a: IRenderItem, b: IRenderItem): number {
    return a.depth - b.depth;
}

export function sortTransparent(a: IRenderItem, b: IRenderItem): number {
    return b.depth - a.depth;
}