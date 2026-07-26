export default `

    float getInstanceCrossFade() {
        const float INV_255 = 1.0 / 255.0;
        return float((aInstancerInstance >> 20u) & 0xffu) * INV_255;
    }
`;