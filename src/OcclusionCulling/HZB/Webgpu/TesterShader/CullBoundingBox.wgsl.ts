export default `

    #include "getRectDepthCS"

    fn cullBoundingBox(boundingBox: BoundingBox, viewProjection: mat4x4<f32>, screenSize: vec2<f32>, hzbSize: vec2<f32>) -> i32 {

        var boundingBoxCorners = array<vec4<f32>, 8>(
            vec4<f32>(boundingBox.center + vec3<f32>( boundingBox.halfExtents.x, boundingBox.halfExtents.y, boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>(-boundingBox.halfExtents.x, boundingBox.halfExtents.y, boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>( boundingBox.halfExtents.x,-boundingBox.halfExtents.y, boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>(-boundingBox.halfExtents.x,-boundingBox.halfExtents.y, boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>( boundingBox.halfExtents.x, boundingBox.halfExtents.y,-boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>(-boundingBox.halfExtents.x, boundingBox.halfExtents.y,-boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>( boundingBox.halfExtents.x,-boundingBox.halfExtents.y,-boundingBox.halfExtents.z), 1.0),
            vec4<f32>(boundingBox.center + vec3<f32>(-boundingBox.halfExtents.x,-boundingBox.halfExtents.y,-boundingBox.halfExtents.z), 1.0)
        );

        var outXPos: i32 = 0;
        var outXNeg: i32 = 0;
        var outYPos: i32 = 0;
        var outYNeg: i32 = 0;
        var outZPos: i32 = 0;
        var outZNeg: i32 = 0;

        var minCoord: vec2<f32> = vec2<f32>(10000.0);
        var maxCoord: vec2<f32> = vec2<f32>(-10000.0);
        var instanceDepth: f32 = 10000.0;

        for (var i: i32 = 0; i < 8; i = i + 1) {

            let bbc = viewProjection * boundingBoxCorners[i];

            outXPos = outXPos + select(0, 1, bbc.x >  bbc.w);
            outXNeg = outXNeg + select(0, 1, bbc.x < -bbc.w);
            outYPos = outYPos + select(0, 1, bbc.y >  bbc.w);
            outYNeg = outYNeg + select(0, 1, bbc.y < -bbc.w);
            outZPos = outZPos + select(0, 1, bbc.z >  bbc.w);
            outZNeg = outZNeg + select(0, 1, bbc.z < -bbc.w);

            let ndc: vec3<f32> = bbc.xyz / bbc.w;
            minCoord = min(minCoord, ndc.xy);
            maxCoord = max(maxCoord, ndc.xy);
            instanceDepth = min(instanceDepth, ndc.z);
        }

        var outsidePlanes: i32 =
            select(0, 1, outXPos > 0 || outXNeg > 0) +
            select(0, 1, outYPos > 0 || outYNeg > 0) +
            select(0, 1, outZPos > 0 || outZNeg > 0);

        // TODO: If an object is partially outside the camera, we consider it visible.
        // This solves the problem when the camera is inside the bounding box.
        if (outsidePlanes == 3) {
            return 3;
        }

        // Frustum outside
        if (outXPos == 8 || outXNeg == 8 ||
            outYPos == 8 || outYNeg == 8 ||
            outZPos == 8 || outZNeg == 8) {
            return 2;
        }

        let clampedMinCoord: vec2<f32> = clamp(minCoord * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
        let clampedMaxCoord: vec2<f32> = clamp(maxCoord * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));

        let hzbInstanceDepth = getRectDepth(clampedMinCoord, clampedMaxCoord, screenSize, hzbSize);

        return select(1, 0, instanceDepth > hzbInstanceDepth);
    }
`;