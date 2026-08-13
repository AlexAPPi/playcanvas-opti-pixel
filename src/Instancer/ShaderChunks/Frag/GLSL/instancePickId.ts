export default `

    #if defined(PICK_PASS) && defined(PICK_CUSTOM_ID) && defined(INSTANCER_USE_PICK_ID)

        vec4 encodePickOutput(uint id);

        flat varying uint vInstancerInstancePickId;

        vec4 getPickOutput() {
            const vec4 inv = vec4(1.0 / 255.0);
            const uvec4 shifts = uvec4(16, 8, 0, 24);
            uvec4 col = (uvec4(vInstancerInstancePickId) >> shifts) & uvec4(0xff);
            return vec4(col) * inv;
        }

    #endif

`;
