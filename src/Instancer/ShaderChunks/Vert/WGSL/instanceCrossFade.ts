export default `

    const INV_255: f32 = 1.0 / 255.0;

    fn getInstanceCrossFade() -> f32 {
        return f32((aInstancerInstance >> 20u) & 0xffu) * INV_255;
    }
`;