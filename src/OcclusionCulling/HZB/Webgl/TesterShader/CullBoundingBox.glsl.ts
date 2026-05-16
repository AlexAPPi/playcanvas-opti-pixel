export default `

    #include "getRectDepthVS"

    int cullBoundingBox(vec3 boxCenter, vec3 boxExtents, out vec3 rectMin, out vec3 rectMax) {

        rectMin = vec3( 1.0,  1.0,  1.0);
        rectMax = vec3(-1.0, -1.0, -1.0);

        vec3 boundsMin = boxCenter.xyz - boxExtents.xyz;
	    vec3 boundsMax = boxCenter.xyz + boxExtents.xyz;
	    vec3 bounds[2] = vec3[](boundsMin, boundsMax);

        for (int i = 0; i < 8; i++) {

            vec3 pointSrc = vec3(
                bounds[(i >> 0) & 1].x,
                bounds[(i >> 1) & 1].y,
                bounds[(i >> 2) & 1].z
            );

            vec4 pointClip   = uMatrixViewProjection * vec4(pointSrc, 1.0);
            vec3 pointScreen = pointClip.xyz / pointClip.w;

            rectMin = min(rectMin, pointScreen);
            rectMax = max(rectMax, pointScreen);
        }

        float rectDepth = getRectDepth(rectMin, rectMax);

        return rectMin.z > rectDepth ? 1 : 0;
    }
`;