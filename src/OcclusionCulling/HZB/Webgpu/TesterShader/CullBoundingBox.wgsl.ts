export default `

    #include "getRectDepthCS"

    fn cullBoundingBox(box: BoundingBox) -> i32 {

        var rectMin = vec3f( 1.0,  1.0,  1.0);
        var rectMax = vec3f(-1.0, -1.0, -1.0);

        let boundsMin = box.center - box.halfExtents;
	    let boundsMax = box.center + box.halfExtents;
	    let bounds    = array<vec3f, 2>(boundsMin, boundsMax);

        for (var i = 0; i < 8; i++) {

            let pointSrc = vec3f(
                bounds[(i >> 0) & 1].x,
                bounds[(i >> 1) & 1].y,
                bounds[(i >> 2) & 1].z
            );

            let pointClip   = uniforms.viewProjection * vec4f(pointSrc, 1.0);
            let pointScreen = pointClip.xyz / pointClip.w;

            rectMin = min(rectMin, pointScreen);
            rectMax = max(rectMax, pointScreen);
        }

        // Crosses near plane
        if (rectMax.z >= 1.0) {
            return 1;
        }

        let rectDepth = getRectDepth(rectMin, rectMax);

        return select(1, 0, rectMin.z > rectDepth);
    }
`;