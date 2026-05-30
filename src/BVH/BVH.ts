import pc from "../engine.js";
import { IBVHBuilder, onLeafCreationCallback } from "./IBVHBuilder.js";
import { minDistanceSqPointToBox, minMaxDistanceSqPointToBox } from "./Utils/BoxUtils.js";
import { intersectsBoxMask, isIntersected } from "./Utils/FrustumUtils.js";
import { intersectBoxBox, intersectRayBox, intersectSphereBox } from "./Utils/IntersectUtils.js";
import { BoxType, BVHNode, FloatArray } from './BVHNode.js';

export interface LODLevel {

    /**
     * The squared distance at which this LOD level becomes active.
     */
    distance: number;

    /**
     * Hysteresis value to prevent LOD flickering when transitioning.
     */
    hysteresis: number;
}

export interface BoxDistance {
    min: number,
    max: number,
}

export type onTraverseCallback<N, L, B extends BoxType> = (node: BVHNode<N, L, B>, depth: number) => boolean;
export type onIntersectionCallback<L> = (obj: L) => boolean;
export type onClosestDistanceCallback<L> = (obj: L) => number;
export type onIntersectionRayCallback<L> = (obj: L) => void;
export type onFrustumIntersectionCallback<N, L, B extends BoxType> = (node: BVHNode<N, L, B>, frustum: pc.Frustum, mask: number) => void;
export type onFrustumIntersectionLODCallback<N, L, B extends BoxType> = (node: BVHNode<N, L, B>, level: number | null, min: number, max: number, frustum: pc.Frustum, mask: number) => void;

export class BVH<N, L, B extends BoxType> {

    public builder: IBVHBuilder<N, L, B>;

    protected _origin: FloatArray;
    protected _dirInv: FloatArray;
    protected _sign = new Uint8Array(3);

    public get root(): BVHNode<N, L, B> {
        return this.builder.root;
    }

    constructor(builder: IBVHBuilder<N, L, B>) {
        this.builder = builder;
        const highPrecision = builder.highPrecision;
        this._dirInv = highPrecision ? new Float64Array(3) : new Float32Array(3);
        this._origin = highPrecision ? new Float64Array(3) : new Float32Array(3);
    }

    public createFromArray(objects: L[], boxes: FloatArray[], onLeafCreation?: onLeafCreationCallback<N, L, B>, margin?: number): void {
        if (objects?.length > 0) {
            this.builder.createFromArray(objects, boxes, onLeafCreation, margin);
        }
    }

    public insert(object: L, box: FloatArray, margin: number): BVHNode<N, L, B> {
        return this.builder.insert(object, box, margin);
    }

    public insertRange(objects: L[], boxes: FloatArray[], margins?: number | FloatArray | number[], onLeafCreation?: onLeafCreationCallback<N, L, B>): void {
        if (objects?.length > 0) {
            this.builder.insertRange(objects, boxes, margins, onLeafCreation);
        }
    }

    public move(node: BVHNode<N, L, B>, margin: number): void {
        this.builder.move(node, margin);
    }

    public delete(node: BVHNode<N, L, B>): BVHNode<N, L, B> {
        return this.builder.delete(node);
    }

    public clear(): void {
        this.builder.clear();
    }

    public traverse(callback: onTraverseCallback<N, L, B>): void {
        if (this.root === null) return;

        _traverse(this.root, 0);

        function _traverse(node: BVHNode<N, L, B>, depth: number): void {
            if (node.object !== undefined) { // is leaf
                callback(node, depth);
                return;
            }

            const stopTraversal = callback(node, depth);

            if (!stopTraversal) {
                _traverse(node.left, depth + 1);
                _traverse(node.right, depth + 1);
            }
        }
    }

    public intersectsRay(dir: FloatArray, origin: FloatArray, onIntersection: onIntersectionCallback<L>, near = 0, far = Infinity): boolean {
        if (this.root === null) return false;

        const dirInv = this._dirInv;
        const sign = this._sign;

        // TODO provare a non passare array

        dirInv[0] = 1 / dir[0];
        dirInv[1] = 1 / dir[1];
        dirInv[2] = 1 / dir[2];

        sign[0] = dirInv[0] < 0 ? 1 : 0;
        sign[1] = dirInv[1] < 0 ? 1 : 0;
        sign[2] = dirInv[2] < 0 ? 1 : 0;

        return _intersectsRay(this.root);

        function _intersectsRay(node: BVHNode<N, L, B>): boolean {
            if (!intersectRayBox(node.box, origin, dirInv, sign, near, far)) return false;

            if (node.object !== undefined) return onIntersection(node.object);

            return _intersectsRay(node.left) || _intersectsRay(node.right);
        }
    }

    public intersectsBox(box: FloatArray, onIntersection: onIntersectionCallback<L>): boolean {
        if (this.root === null) return false;

        return _intersectsBox(this.root);

        function _intersectsBox(node: BVHNode<N, L, B>): boolean {
            if (!intersectBoxBox(box, node.box)) return false;

            if (node.object !== undefined) return onIntersection(node.object);

            return _intersectsBox(node.left) || _intersectsBox(node.right);
        }
    }

    public intersectsSphere(center: FloatArray, radius: number, onIntersection: onIntersectionCallback<L>): boolean {
        if (this.root === null) return false;

        return _intersectsSphere(this.root);

        function _intersectsSphere(node: BVHNode<N, L, B>): boolean {
            if (!intersectSphereBox(center, radius, node.box)) return false;

            if (node.object !== undefined) return onIntersection(node.object);

            return _intersectsSphere(node.left) || _intersectsSphere(node.right);
        }
    }

    public isNodeIntersected(node: BVHNode<N, L, B>, onIntersection: onIntersectionCallback<L>): boolean {
        const nodeBox = node.box;
        let parent;

        while ((parent = node.parent)) {
            const oppositeNode = parent.left === node ? parent.right : parent.left;

            if (_isNodeIntersected(oppositeNode)) return true;

            node = parent;
        }

        return false;

        function _isNodeIntersected(node: BVHNode<N, L, B>): boolean {
            if (!intersectBoxBox(nodeBox, node.box)) return false;

            if (node.object !== undefined) return onIntersection(node.object);

            return _isNodeIntersected(node.left) || _isNodeIntersected(node.right);
        }
    }

    public rayIntersections(ray: pc.Ray, onIntersection: onIntersectionRayCallback<L>, near = 0, far = Infinity): void {
        if (this.root === null) return;

        const dirInv = this._dirInv;
        const sign = this._sign;
        const origin = this._origin;

        dirInv[0] = 1 / ray.direction.x;
        dirInv[1] = 1 / ray.direction.y;
        dirInv[2] = 1 / ray.direction.z;

        origin[0] = ray.origin.x;
        origin[1] = ray.origin.y;
        origin[2] = ray.origin.z;

        sign[0] = dirInv[0] < 0 ? 1 : 0;
        sign[1] = dirInv[1] < 0 ? 1 : 0;
        sign[2] = dirInv[2] < 0 ? 1 : 0;

        _rayIntersections(this.root);

        function _rayIntersections(node: BVHNode<N, L, B>): void {
            if (!intersectRayBox(node.box, origin, dirInv, sign, near, far)) return;

            if (node.object !== undefined) {
                onIntersection(node.object);
                return;
            }

            _rayIntersections(node.left);
            _rayIntersections(node.right);
        }
    }

    public frustumCulling(frustum: pc.Frustum, onIntersection: onFrustumIntersectionCallback<N, L, B>): void {

        if (this.root === null) return;

        _frustumCulling(this.root, 0b111111);

        function _frustumCulling(node: BVHNode<N, L, B>, mask: number): void {

            if (node.object !== undefined) {
                if (isIntersected(frustum, node.box, mask)) {
                    onIntersection(node, frustum, mask);
                }
                return;
            }

            mask = intersectsBoxMask(frustum, node.box, mask);

            if (mask < 0) return; // -1 = out

            if (mask === 0) { // 0 = in
                showAll(node.left);
                showAll(node.right);
                return;
            }

            _frustumCulling(node.left, mask);
            _frustumCulling(node.right, mask);
        }

        function showAll(node: BVHNode<N, L, B>): void {
            if (node.object !== undefined) {
                onIntersection(node, frustum, 0);
                return;
            }
            showAll(node.left);
            showAll(node.right);
        }
    }

    public frustumCullingLOD(frustum: pc.Frustum, cameraPosition: FloatArray, levels: LODLevel[], onIntersection: onFrustumIntersectionLODCallback<N, L, B>): void {
        if (this.root === null) return;

        _frustumCullingLOD(this.root, 0b111111, null, -Infinity, Infinity);

        function _frustumCullingLOD(node: BVHNode<N, L, B>, mask: number, level: number | null, min: number, max: number): void {

            const nodeBox = node.box;

            if (level === null) { // TODO trying use mask here?
                const distance = minMaxDistanceSqPointToBox(nodeBox, cameraPosition);
                min = distance.min;
                max = distance.max;
                level = getLevel(min, max);
            }

            if (node.object !== undefined) {
                if (isIntersected(frustum, nodeBox, mask)) {
                    onIntersection(node, level, min, max, frustum, mask);
                }
                return;
            }

            mask = intersectsBoxMask(frustum, nodeBox, mask);

            if (mask < 0) return; // -1 = out

            if (mask === 0) { // 0 = in
                showAll(node.left, level, min, max);
                showAll(node.right, level, min, max);
                return;
            }

            _frustumCullingLOD(node.left, mask, level, min, max);
            _frustumCullingLOD(node.right, mask, level, min, max);
        }

        function showAll(node: BVHNode<N, L, B>, level: number | null, min: number, max: number): void {

            const nodeBox = node.box;

            if (level === null) {
                const distance = minMaxDistanceSqPointToBox(nodeBox, cameraPosition);
                min = distance.min;
                max = distance.max;
                level = getLevel(min, max);
            }

            if (node.object !== undefined) {
                onIntersection(node, level, min, max, frustum, 0);
                return;
            }

            showAll(node.left, level, min, max);
            showAll(node.right, level, min, max);
        }

        function getLevel(min: number, max: number): number | null {

            for (let i = levels.length - 1; i > 0; i--) {
                // if we want to add hysteresis -> const levelDistance = level - (level * hysteresis);
                if (max >= levels[i].distance) {
                    return min >= levels[i].distance ? i : null;
                }
            }

            return 0;
        }
    }

    // onClosestDistance callback should return SQUARED distance
    public closestPointToPoint(point: FloatArray, onClosestDistance?: onClosestDistanceCallback<L>): number {
        if (this.root === null) return Infinity;

        let bestDistance = Infinity;

        _closestPointToPoint(this.root);

        return Math.sqrt(bestDistance);

        function _closestPointToPoint(node: BVHNode<N, L, B>): void {
            if (node.object !== undefined) {
                if (onClosestDistance) {
                    const distance = onClosestDistance(node.object) ?? minDistanceSqPointToBox(node.box, point);
                    if (distance < bestDistance) bestDistance = distance;
                } else {
                    bestDistance = minDistanceSqPointToBox(node.box, point); // this was already calculated actually
                }

                return;
            }

            const leftDistance = minDistanceSqPointToBox(node.left.box, point);
            const rightDistance = minDistanceSqPointToBox(node.right.box, point);

            if (leftDistance < rightDistance) {
                if (leftDistance < bestDistance) {
                    _closestPointToPoint(node.left);
                    if (rightDistance < bestDistance) _closestPointToPoint(node.right);
                }
            } else if (rightDistance < bestDistance) {
                _closestPointToPoint(node.right);
                if (leftDistance < bestDistance) _closestPointToPoint(node.left);
            }
        }
    }
}