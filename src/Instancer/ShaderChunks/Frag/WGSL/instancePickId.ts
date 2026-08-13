export default `

    #if defined(PICK_PASS) && defined(PICK_CUSTOM_ID) && defined(INSTANCER_USE_PICK_ID)

        varying @interpolate(flat) vInstancerInstancePickId: u32;

        fn getPickOutput() -> vec4f {
            let inv = vec4f(1.0 / 255.0);
            let shifts = vec4u(16u, 8u, 0u, 24u);
            let col = (vec4u(vInstancerInstancePickId) >> shifts) & vec4u(0xffu);
            return vec4f(col) * inv;
        }

    #endif

`;
