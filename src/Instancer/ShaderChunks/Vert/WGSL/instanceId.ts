export default `

    attribute aInstancerInstance: u32;

    fn getInstanceId() -> u32 {

        #ifdef INSTANCER_USE_CROSSFADE
            return aInstancerInstance & 0xfffffu;
        #else
            return aInstancerInstance;
        #endif
    }
`;