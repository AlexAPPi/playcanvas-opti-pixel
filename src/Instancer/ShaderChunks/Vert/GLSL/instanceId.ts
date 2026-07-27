export default `

    attribute uint aInstancerInstance;

    uint getInstanceId() {

        #ifdef INSTANCER_USE_CROSSFADE
            return aInstancerInstance & 0xfffffu;
        #else
            return aInstancerInstance;
        #endif
    }
`;