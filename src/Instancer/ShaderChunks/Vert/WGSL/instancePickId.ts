export default `

    #if defined(PICK_PASS) && defined(PICK_CUSTOM_ID) && defined(INSTANCER_USE_PICK_ID)

        #ifdef INSTANCER_USE_LAYERS
            uniform vInstancerLayerPickId: u32;
        #else
            uniform uInstancerPickId: u32;
        #endif

        fn getInstancePickId() -> u32 {

            let instanceId = getInstanceId() & 0xfffffu;

            #ifdef INSTANCER_USE_LAYERS

                return instanceId | (uniform.vInstancerLayerPickId << 20u);

            #else

                return instanceId | (uniform.uInstancerPickId << 20u);

            #endif
        }

    #endif

`;
