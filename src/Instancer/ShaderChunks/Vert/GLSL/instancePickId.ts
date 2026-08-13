export default `

    #if defined(PICK_PASS) && defined(PICK_CUSTOM_ID) && defined(INSTANCER_USE_PICK_ID)

        #ifdef INSTANCER_USE_LAYERS
            uniform uint vInstancerLayerPickId;
        #else
            uniform uint uInstancerPickId;
        #endif

        uint getInstancePickId() {

            uint instanceId = getInstanceId() & 0xfffffu;

            #ifdef INSTANCER_USE_LAYERS

                return instanceId | (vInstancerLayerPickId << 20u);

            #else

                return instanceId | (uInstancerPickId << 20u);

            #endif
        }

    #endif

`;