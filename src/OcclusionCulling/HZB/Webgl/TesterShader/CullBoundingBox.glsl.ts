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

    int cullBoundingBox(vec3 boxCenterWorld, vec3 boxHalfExtents, out float instanceDepth, out float hzbDepth, out vec2 minCoord, out vec2 maxCoord) {

        instanceDepth = 1e6;
        hzbDepth = -1e6;

        minCoord = vec2(1e6);
        maxCoord = vec2(-1e6);

        vec4[8] boundingBoxCorners = getBoundingBoxCorners(boxCenterWorld, boxHalfExtents);

        #if CHECK_FRUSTUM
        int outXPos = 0;
        int outXNeg = 0;
        int outYPos = 0;
        int outYNeg = 0;
        int outZPos = 0;
        int outZNeg = 0;
        #endif

        for (int i = 0; i < 8; i++) {

            vec4 point = uMatrixViewProjection * boundingBoxCorners[i];

            #if CHECK_FRUSTUM
            if (point.x >  point.w) outXPos++;
            if (point.x < -point.w) outXNeg++;
            if (point.y >  point.w) outYPos++;
            if (point.y < -point.w) outYNeg++;
            if (point.z >  point.w) outZPos++;
            if (point.z < -point.w) outZNeg++;
            #endif

            point.xyz /= point.w;

            minCoord = min(minCoord, point.xy);
            maxCoord = max(maxCoord, point.xy);
            instanceDepth = min(instanceDepth, point.z);
        }

        // Convert from NDC space [-1, 1] to texture space [0, 1]
        minCoord = minCoord * 0.5 + 0.5;
        maxCoord = maxCoord * 0.5 + 0.5;

        #if CHECK_FRUSTUM
        if (outXPos == 8 || outXNeg == 8 ||
            outYPos == 8 || outYNeg == 8 ||
            outZPos == 8 || outZNeg == 8) {
            return 2;
        }
        #endif

        hzbDepth = getRectDepth(minCoord, maxCoord);

        return instanceDepth > hzbDepth ? 1 : 0;
    }
`;