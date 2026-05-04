export default `

    #include "getRectDepthVS"

    int cullBoundingBox(vec3 boxCenterWorld, vec3 boxHalfExtents, mat4 viewProjection, vec2 screenSize, vec2 hzbSize, out float instanceDepth, out float hzbDepth) {

        instanceDepth = 1e6;
        hzbDepth = -1e6;

        vec4 boundingBox[8];

        boundingBox[0] = vec4(boxCenterWorld + vec3( boxHalfExtents.x, boxHalfExtents.y, boxHalfExtents.z), 1.0);
        boundingBox[1] = vec4(boxCenterWorld + vec3(-boxHalfExtents.x, boxHalfExtents.y, boxHalfExtents.z), 1.0);
        boundingBox[2] = vec4(boxCenterWorld + vec3( boxHalfExtents.x,-boxHalfExtents.y, boxHalfExtents.z), 1.0);
        boundingBox[3] = vec4(boxCenterWorld + vec3(-boxHalfExtents.x,-boxHalfExtents.y, boxHalfExtents.z), 1.0);
        boundingBox[4] = vec4(boxCenterWorld + vec3( boxHalfExtents.x, boxHalfExtents.y,-boxHalfExtents.z), 1.0);
        boundingBox[5] = vec4(boxCenterWorld + vec3(-boxHalfExtents.x, boxHalfExtents.y,-boxHalfExtents.z), 1.0);
        boundingBox[6] = vec4(boxCenterWorld + vec3( boxHalfExtents.x,-boxHalfExtents.y,-boxHalfExtents.z), 1.0);
        boundingBox[7] = vec4(boxCenterWorld + vec3(-boxHalfExtents.x,-boxHalfExtents.y,-boxHalfExtents.z), 1.0);

        #if CHECK_FRUSTUM
        int outXPos = 0;
        int outXNeg = 0;
        int outYPos = 0;
        int outYNeg = 0;
        int outZPos = 0;
        int outZNeg = 0;
        #endif

        vec2 minCoord = vec2(1e6);
        vec2 maxCoord = vec2(-1e6);

        for (int i = 0; i < 8; i++) {

            vec4 current = viewProjection * boundingBox[i];

            #if CHECK_FRUSTUM
            if (current.x >  current.w) outXPos++;
            if (current.x < -current.w) outXNeg++;
            if (current.y >  current.w) outYPos++;
            if (current.y < -current.w) outYNeg++;
            if (current.z >  current.w) outZPos++;
            if (current.z < -current.w) outZNeg++;
            #endif

            current.xyz /= current.w;

            minCoord = min(minCoord, current.xy);
            maxCoord = max(maxCoord, current.xy);
            instanceDepth = min(instanceDepth, current.z);
        }

        #if CHECK_FRUSTUM
        if (outXPos == 8 || outXNeg == 8 || outYPos == 8 || outYNeg == 8 || outZPos == 8 || outZNeg == 8) {
            return 2;
        }
        #endif

        minCoord = clamp(minCoord * 0.5 + 0.5, 0.0, 1.0);
        maxCoord = clamp(maxCoord * 0.5 + 0.5, 0.0, 1.0);

        hzbDepth = getRectDepth(minCoord, maxCoord, screenSize, hzbSize);

        return instanceDepth > hzbDepth ? 1 : 0;
    }
`;