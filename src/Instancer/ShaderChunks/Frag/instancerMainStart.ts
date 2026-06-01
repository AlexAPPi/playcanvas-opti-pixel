export default `

    #include "instancerMainStartPS"

    #if INSTANCER_USE_CROSSFADE
    if (vInstancerCrossFade < 0.05) {
        discard;
    }
    #endif
`;