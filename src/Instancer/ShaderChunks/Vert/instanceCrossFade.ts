export default `

    float getInstanceCrossFade() {
        return float((aInstanceIndex >> 20u) & 0xffu) / 255.0;
    }
`;