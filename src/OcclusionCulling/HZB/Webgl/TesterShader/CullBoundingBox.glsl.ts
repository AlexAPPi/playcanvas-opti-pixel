export default `

    #include "getRectDepthVS"

    vec3[8] getBoundingBoxCorners(vec3 boxCenterWorld, vec3 boxHalfExtents) {
        vec3 boundingBoxCorners[8];
        boundingBoxCorners[0] = boxCenterWorld + vec3( boxHalfExtents.x, boxHalfExtents.y, boxHalfExtents.z);
        boundingBoxCorners[1] = boxCenterWorld + vec3(-boxHalfExtents.x, boxHalfExtents.y, boxHalfExtents.z);
        boundingBoxCorners[2] = boxCenterWorld + vec3( boxHalfExtents.x,-boxHalfExtents.y, boxHalfExtents.z);
        boundingBoxCorners[3] = boxCenterWorld + vec3(-boxHalfExtents.x,-boxHalfExtents.y, boxHalfExtents.z);
        boundingBoxCorners[4] = boxCenterWorld + vec3( boxHalfExtents.x, boxHalfExtents.y,-boxHalfExtents.z);
        boundingBoxCorners[5] = boxCenterWorld + vec3(-boxHalfExtents.x, boxHalfExtents.y,-boxHalfExtents.z);
        boundingBoxCorners[6] = boxCenterWorld + vec3( boxHalfExtents.x,-boxHalfExtents.y,-boxHalfExtents.z);
        boundingBoxCorners[7] = boxCenterWorld + vec3(-boxHalfExtents.x,-boxHalfExtents.y,-boxHalfExtents.z);
        return boundingBoxCorners;
    }

    int cullBoundingBox(vec3 boxCenterWorld, vec3 boxHalfExtents, out vec3 rectMin, out vec3 rectMax) {

        rectMin = vec3( 1.0,  1.0,  1.0);
        rectMax = vec3(-1.0, -1.0, -1.0);

        vec3[8] boundingBoxCorners = getBoundingBoxCorners(boxCenterWorld, boxHalfExtents);

        for (int i = 0; i < 8; i++) {

            vec4 pointClip = uMatrixViewProjection * vec4(boundingBoxCorners[i], 1.0);
            vec3 pointScreen = pointClip.xyz / pointClip.w;

            rectMin = min(rectMin, pointScreen);
            rectMax = max(rectMax, pointScreen);
        }

        float minDepth = getRectDepth(rectMin, rectMax);

        return rectMax.z > minDepth ? 1 : 0;
    }
`;