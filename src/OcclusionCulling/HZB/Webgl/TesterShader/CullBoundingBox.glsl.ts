export default `

    #include "getRectDepthVS"

    vec4[8] getBoundingBoxCorners(vec3 boxCenterWorld, vec3 boxHalfExtents) {
        vec4 boundingBoxCorners[8];
        boundingBoxCorners[0] = vec4(boxCenterWorld + vec3( boxHalfExtents.x, boxHalfExtents.y, boxHalfExtents.z), 1.0);
        boundingBoxCorners[1] = vec4(boxCenterWorld + vec3(-boxHalfExtents.x, boxHalfExtents.y, boxHalfExtents.z), 1.0);
        boundingBoxCorners[2] = vec4(boxCenterWorld + vec3( boxHalfExtents.x,-boxHalfExtents.y, boxHalfExtents.z), 1.0);
        boundingBoxCorners[3] = vec4(boxCenterWorld + vec3(-boxHalfExtents.x,-boxHalfExtents.y, boxHalfExtents.z), 1.0);
        boundingBoxCorners[4] = vec4(boxCenterWorld + vec3( boxHalfExtents.x, boxHalfExtents.y,-boxHalfExtents.z), 1.0);
        boundingBoxCorners[5] = vec4(boxCenterWorld + vec3(-boxHalfExtents.x, boxHalfExtents.y,-boxHalfExtents.z), 1.0);
        boundingBoxCorners[6] = vec4(boxCenterWorld + vec3( boxHalfExtents.x,-boxHalfExtents.y,-boxHalfExtents.z), 1.0);
        boundingBoxCorners[7] = vec4(boxCenterWorld + vec3(-boxHalfExtents.x,-boxHalfExtents.y,-boxHalfExtents.z), 1.0);
        return boundingBoxCorners;
    }

    int cullBoundingBox(vec3 boxCenterWorld, vec3 boxHalfExtents, out vec3 rectMin, out vec3 rectMax) {

        rectMin = vec3( 1.0,  1.0,  1.0);
        rectMax = vec3(-1.0, -1.0, -1.0);

        vec4[8] boundingBoxCorners = getBoundingBoxCorners(boxCenterWorld, boxHalfExtents);

        for (int i = 0; i < 8; i++) {

            vec4 pointClip = uMatrixViewProjection * boundingBoxCorners[i];
            vec3 pointScreen = pointClip.xyz / pointClip.w;

            rectMin = min(rectMin, pointScreen);
            rectMax = max(rectMax, pointScreen);
        }

        float minDepth = getRectDepth(rectMin, rectMax);

        return rectMax.z >= minDepth ? 1 : 0;
    }
`;