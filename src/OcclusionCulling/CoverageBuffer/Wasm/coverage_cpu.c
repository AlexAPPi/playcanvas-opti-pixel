/*
 * CoverageCpuBuffer kernels for wasm32 + SIMD128.
 *
 * Pixel scatter / copy / hole-fill / rect walks and AABB project/clip are f32x4.
 * Mat4 invert/mul use f64x2 (same precision as the JS path).
 * Built by scripts/build-coverage-wasm.mjs.
 */
#include <stdint.h>
#include <stddef.h>
#include <wasm_simd128.h>

#define NEAR_EPS 1e-5f
#define PAGE 65536u
#define VISIBLE 0
#define OCCLUDED 1
#define UNKNOWN -1
#define SHUF(v, a, b, c, d) wasm_i32x4_shuffle((v), (v), (a), (b), (c), (d))

#define WASM_EXPORT(NAME) __attribute__((visibility("default"), export_name(NAME)))

extern unsigned char __heap_base;

static int32_t g_width;
static int32_t g_height;
static int32_t g_n0;
static int32_t g_built;
static int32_t g_has_src;
static int32_t g_src_ortho;
static int32_t g_dst_ortho;
static int32_t g_rect_pad;
static int32_t g_last_x;
static int32_t g_last_y;

static double g_aabb_expand;
static double g_cam_x;
static double g_cam_y;
static double g_cam_z;
static float g_min_x;
static float g_min_y;
static float g_max_x;
static float g_max_y;
static float g_min_eye;
static float g_max_eye;

static float g_src_near = 0.1f;
static float g_src_far = 1000.f;
static float g_dst_near = 0.1f;
static float g_dst_far = 1000.f;
static float g_global_min = 1.f;
static float g_global_max = 1.f;
static float g_sxk;
static float g_syk;

static float src_vp[16] __attribute__((aligned(16)));
static float dst_vp[16] __attribute__((aligned(16)));
static float src_params[4] __attribute__((aligned(16)));
static float dst_params[4] __attribute__((aligned(16)));
static float view_m[16] __attribute__((aligned(16)));
static float test_vp[16] __attribute__((aligned(16)));
static float in_dst_vp[16] __attribute__((aligned(16)));
static float inv_m[16] __attribute__((aligned(16)));
static float reproject_m[16] __attribute__((aligned(16)));

static float g_cx[8] __attribute__((aligned(16)));
static float g_cy[8] __attribute__((aligned(16)));
static float g_cz[8] __attribute__((aligned(16)));
static float g_cw[8] __attribute__((aligned(16)));

static float *g_src;
static float *g_dest;
static uint8_t *g_mask;
static int32_t *g_holes;

static int32_t g_aabb_cap;
static float *g_centers;
static float *g_halves;
static int32_t *g_queue;
static int8_t *g_flags;
static int8_t *g_flags0;
static int8_t *g_flags1;

static const uint8_t EDGE0[12] = {0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3};
static const uint8_t EDGE1[12] = {1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7};

static uintptr_t align16u(uintptr_t p) {
    return (p + 15u) & ~(uintptr_t)15u;
}

static void ensure_bytes(uintptr_t end) {
    uint32_t need = (uint32_t)((end + (PAGE - 1u)) / PAGE);
    uint32_t have = (uint32_t)__builtin_wasm_memory_size(0);
    if (need > have) {
        if (__builtin_wasm_memory_grow(0, need - have) == (size_t)-1) {
            __builtin_trap();
        }
    }
}

static float hmin4(v128_t v) {
    v128_t t = wasm_f32x4_min(v, SHUF(v, 1, 0, 3, 2));
    t = wasm_f32x4_min(t, SHUF(t, 2, 3, 0, 1));
    return wasm_f32x4_extract_lane(t, 0);
}

static float hmax4(v128_t v) {
    v128_t t = wasm_f32x4_max(v, SHUF(v, 1, 0, 3, 2));
    t = wasm_f32x4_max(t, SHUF(t, 2, 3, 0, 1));
    return wasm_f32x4_extract_lane(t, 0);
}

static float hsum4(v128_t v) {
    v128_t t = wasm_f32x4_add(v, SHUF(v, 1, 0, 3, 2));
    t = wasm_f32x4_add(t, SHUF(t, 2, 3, 0, 1));
    return wasm_f32x4_extract_lane(t, 0);
}

static v128_t madd(v128_t acc, v128_t a, float s) {
    return wasm_f32x4_add(acc, wasm_f32x4_mul(a, wasm_f32x4_splat(s)));
}

static void fill_i8(int8_t *p, int32_t n, int8_t v) {
    if (!p || n <= 0) {
        return;
    }
    v128_t vec = wasm_i8x16_splat(v);
    int32_t i = 0;
    int32_t n16 = n & ~15;
    for (; i < n16; i += 16) {
        wasm_v128_store(p + i, vec);
    }
    for (; i < n; i++) {
        p[i] = v;
    }
}

static void apply_layout(void) {
    int32_t n = g_n0;
    int32_t cap = g_aabb_cap;
    uintptr_t p = align16u((uintptr_t)&__heap_base);
    g_src = n > 0 ? (float *)p : (float *)0;
    p = align16u(p + (uintptr_t)n * 4u);
    g_dest = n > 0 ? (float *)p : (float *)0;
    p = align16u(p + (uintptr_t)n * 4u + (n > 0 ? 16u : 0u));
    g_mask = n > 0 ? (uint8_t *)p : (uint8_t *)0;
    p = align16u(p + (uintptr_t)n);
    g_holes = n > 0 ? (int32_t *)p : (int32_t *)0;
    p = align16u(p + (uintptr_t)n * 4u);
    g_centers = cap > 0 ? (float *)p : (float *)0;
    p = align16u(p + (uintptr_t)cap * 16u);
    g_halves = cap > 0 ? (float *)p : (float *)0;
    p = align16u(p + (uintptr_t)cap * 16u);
    g_queue = cap > 0 ? (int32_t *)p : (int32_t *)0;
    p = align16u(p + (uintptr_t)cap * 4u);
    g_flags0 = cap > 0 ? (int8_t *)p : (int8_t *)0;
    p = align16u(p + (uintptr_t)cap);
    g_flags1 = cap > 0 ? (int8_t *)p : (int8_t *)0;
    p = align16u(p + (uintptr_t)cap);
    g_flags = g_flags0;
    ensure_bytes(p);
}

static uintptr_t layout_end(int32_t n, int32_t cap) {
    uintptr_t p = align16u((uintptr_t)&__heap_base);
    p = align16u(p + (uintptr_t)n * 4u);
    p = align16u(p + (uintptr_t)n * 4u + (n > 0 ? 16u : 0u));
    p = align16u(p + (uintptr_t)n);
    p = align16u(p + (uintptr_t)n * 4u);
    p = align16u(p + (uintptr_t)cap * 16u);
    p = align16u(p + (uintptr_t)cap * 16u);
    p = align16u(p + (uintptr_t)cap * 4u);
    p = align16u(p + (uintptr_t)cap);
    p = align16u(p + (uintptr_t)cap);
    return p;
}

static void copy_f32(float *dst, const float *src, int32_t n) {
    if (!dst || !src || n <= 0 || dst == src) {
        return;
    }
    int32_t i = 0;
    int32_t n4 = n & ~3;
    for (; i < n4; i += 4) {
        wasm_v128_store(dst + i, wasm_v128_load(src + i));
    }
    for (; i < n; i++) {
        dst[i] = src[i];
    }
}

static void copy_i8(int8_t *dst, const int8_t *src, int32_t n) {
    if (!dst || !src || n <= 0 || dst == src) {
        return;
    }
    int32_t i = 0;
    int32_t n16 = n & ~15;
    for (; i < n16; i += 16) {
        wasm_v128_store(dst + i, wasm_v128_load(src + i));
    }
    for (; i < n; i++) {
        dst[i] = src[i];
    }
}

static void copy_i32(int32_t *dst, const int32_t *src, int32_t n) {
    if (!dst || !src || n <= 0 || dst == src) {
        return;
    }
    int32_t i = 0;
    int32_t n4 = n & ~3;
    for (; i < n4; i += 4) {
        wasm_v128_store(dst + i, wasm_v128_load(src + i));
    }
    for (; i < n; i++) {
        dst[i] = src[i];
    }
}

static void relayout_keep_aabbs(int32_t new_n, int32_t new_cap) {
    int32_t old_cap = g_aabb_cap;
    int32_t keep = old_cap < new_cap ? old_cap : new_cap;
    int32_t keepf = keep << 2;
    float *oc = g_centers;
    float *oh = g_halves;
    int32_t *oq = g_queue;
    int8_t *of0 = g_flags0;
    int8_t *of1 = g_flags1;
    uintptr_t stash = layout_end(new_n, new_cap);
    float *sc = (float *)stash;
    float *sh = sc + keepf;
    int32_t *sq = (int32_t *)(sh + keepf);
    int8_t *sf0 = (int8_t *)(sq + keep);
    int8_t *sf1 = sf0 + keep;
    ensure_bytes(align16u((uintptr_t)(sf1 + keep)));
    if (keep > 0 && oc && oh) {
        copy_f32(sc, oc, keepf);
        copy_f32(sh, oh, keepf);
        if (oq) {
            copy_i32(sq, oq, keep);
        }
        if (of0) {
            copy_i8(sf0, of0, keep);
        }
        if (of1) {
            copy_i8(sf1, of1, keep);
        }
    }
    g_n0 = new_n;
    g_aabb_cap = new_cap;
    apply_layout();
    if (keep > 0 && g_centers && g_halves) {
        copy_f32(g_centers, sc, keepf);
        copy_f32(g_halves, sh, keepf);
        if (g_queue && oq) {
            copy_i32(g_queue, sq, keep);
        }
        if (g_flags0) {
            if (of0) {
                copy_i8(g_flags0, sf0, keep);
            }
            if (new_cap > keep) {
                fill_i8(g_flags0 + keep, new_cap - keep, (int8_t)UNKNOWN);
            }
        }
        if (g_flags1) {
            if (of1) {
                copy_i8(g_flags1, sf1, keep);
            }
            if (new_cap > keep) {
                fill_i8(g_flags1 + keep, new_cap - keep, (int8_t)UNKNOWN);
            }
        }
    } else {
        fill_i8(g_flags0, new_cap, (int8_t)UNKNOWN);
        fill_i8(g_flags1, new_cap, (int8_t)UNKNOWN);
    }
    g_flags = g_flags0;
}

static void fill_f32(float *p, int32_t n, float v) {
    v128_t vec = wasm_f32x4_splat(v);
    int32_t i = 0;
    int32_t n4 = n & ~3;
    for (; i < n4; i += 4) {
        wasm_v128_store(p + i, vec);
    }
    for (; i < n; i++) {
        p[i] = v;
    }
}

static int eq16(const float *a, const float *b) {
    v128_t d = wasm_v128_or(
        wasm_v128_or(
            wasm_f32x4_ne(wasm_v128_load(a), wasm_v128_load(b)),
            wasm_f32x4_ne(wasm_v128_load(a + 4), wasm_v128_load(b + 4))),
        wasm_v128_or(
            wasm_f32x4_ne(wasm_v128_load(a + 8), wasm_v128_load(b + 8)),
            wasm_f32x4_ne(wasm_v128_load(a + 12), wasm_v128_load(b + 12))));
    return !wasm_v128_any_true(d);
}

static void copy16(float *dst, const float *src) {
    wasm_v128_store(dst, wasm_v128_load(src));
    wasm_v128_store(dst + 4, wasm_v128_load(src + 4));
    wasm_v128_store(dst + 8, wasm_v128_load(src + 8));
    wasm_v128_store(dst + 12, wasm_v128_load(src + 12));
}

static void load_col_f64(const float *m, v128_t *xy, v128_t *zw) {
    v128_t f = wasm_v128_load(m);
    *xy = wasm_f64x2_promote_low_f32x4(f);
    *zw = wasm_f64x2_promote_low_f32x4(wasm_i32x4_shuffle(f, f, 2, 3, 0, 1));
}

static void store_col_f64(float *m, v128_t xy, v128_t zw) {
    v128_t lo = wasm_f32x4_demote_f64x2_zero(xy);
    v128_t hi = wasm_f32x4_demote_f64x2_zero(zw);
    wasm_v128_store(m, wasm_i32x4_shuffle(lo, hi, 0, 1, 4, 5));
}

static v128_t madd64(v128_t acc, v128_t a, double s) {
    return wasm_f64x2_add(acc, wasm_f64x2_mul(a, wasm_f64x2_splat(s)));
}

static double hsum2(v128_t v) {
    return wasm_f64x2_extract_lane(v, 0) + wasm_f64x2_extract_lane(v, 1);
}

static void mul16(float *out, const float *a, const float *b) {
    v128_t a0xy, a0zw, a1xy, a1zw, a2xy, a2zw, a3xy, a3zw;
    load_col_f64(a, &a0xy, &a0zw);
    load_col_f64(a + 4, &a1xy, &a1zw);
    load_col_f64(a + 8, &a2xy, &a2zw);
    load_col_f64(a + 12, &a3xy, &a3zw);
    for (int c = 0; c < 4; c++) {
        const float *bc = b + (c << 2);
        v128_t xy = wasm_f64x2_mul(a0xy, wasm_f64x2_splat((double)bc[0]));
        xy = madd64(xy, a1xy, (double)bc[1]);
        xy = madd64(xy, a2xy, (double)bc[2]);
        xy = madd64(xy, a3xy, (double)bc[3]);
        v128_t zw = wasm_f64x2_mul(a0zw, wasm_f64x2_splat((double)bc[0]));
        zw = madd64(zw, a1zw, (double)bc[1]);
        zw = madd64(zw, a2zw, (double)bc[2]);
        zw = madd64(zw, a3zw, (double)bc[3]);
        store_col_f64(out + (c << 2), xy, zw);
    }
}

static v128_t det2_64(v128_t a, v128_t b, v128_t c, v128_t d) {
    return wasm_f64x2_sub(wasm_f64x2_mul(a, b), wasm_f64x2_mul(c, d));
}

static v128_t f64pair_mul_add3(v128_t p1, double k1, v128_t p2, double k2, v128_t p3, double k3, double det) {
    v128_t s = madd64(madd64(wasm_f64x2_mul(p1, wasm_f64x2_splat(k1)), p2, k2), p3, k3);
    return wasm_f64x2_mul(s, wasm_f64x2_splat(det));
}

static int invert16(float *out, const float *m) {
    v128_t c0xy, c0zw, c1xy, c1zw, c2xy, c2zw, c3xy, c3zw;
    load_col_f64(m, &c0xy, &c0zw);
    load_col_f64(m + 4, &c1xy, &c1zw);
    load_col_f64(m + 8, &c2xy, &c2zw);
    load_col_f64(m + 12, &c3xy, &c3zw);

    double m00 = wasm_f64x2_extract_lane(c0xy, 0);
    double m01 = wasm_f64x2_extract_lane(c0xy, 1);
    double m02 = wasm_f64x2_extract_lane(c0zw, 0);
    double m03 = wasm_f64x2_extract_lane(c0zw, 1);
    double m10 = wasm_f64x2_extract_lane(c1xy, 0);
    double m11 = wasm_f64x2_extract_lane(c1xy, 1);
    double m12 = wasm_f64x2_extract_lane(c1zw, 0);
    double m13 = wasm_f64x2_extract_lane(c1zw, 1);
    double m20 = wasm_f64x2_extract_lane(c2xy, 0);
    double m21 = wasm_f64x2_extract_lane(c2xy, 1);
    double m22 = wasm_f64x2_extract_lane(c2zw, 0);
    double m23 = wasm_f64x2_extract_lane(c2zw, 1);
    double m30 = wasm_f64x2_extract_lane(c3xy, 0);
    double m31 = wasm_f64x2_extract_lane(c3xy, 1);
    double m32 = wasm_f64x2_extract_lane(c3zw, 0);
    double m33 = wasm_f64x2_extract_lane(c3zw, 1);

    v128_t u01 = det2_64(wasm_f64x2_make(m00, m00), wasm_f64x2_make(m11, m12), wasm_f64x2_make(m01, m02), wasm_f64x2_make(m10, m10));
    v128_t u23 = det2_64(wasm_f64x2_make(m00, m01), wasm_f64x2_make(m13, m12), wasm_f64x2_make(m03, m02), wasm_f64x2_make(m10, m11));
    v128_t u45 = det2_64(wasm_f64x2_make(m01, m02), wasm_f64x2_make(m13, m13), wasm_f64x2_make(m03, m03), wasm_f64x2_make(m11, m12));
    v128_t v01 = det2_64(wasm_f64x2_make(m20, m20), wasm_f64x2_make(m31, m32), wasm_f64x2_make(m21, m22), wasm_f64x2_make(m30, m30));
    v128_t v23 = det2_64(wasm_f64x2_make(m20, m21), wasm_f64x2_make(m33, m32), wasm_f64x2_make(m23, m22), wasm_f64x2_make(m30, m31));
    v128_t v45 = det2_64(wasm_f64x2_make(m21, m22), wasm_f64x2_make(m33, m33), wasm_f64x2_make(m23, m23), wasm_f64x2_make(m31, m32));

    double b00 = wasm_f64x2_extract_lane(u01, 0);
    double b01 = wasm_f64x2_extract_lane(u01, 1);
    double b02 = wasm_f64x2_extract_lane(u23, 0);
    double b03 = wasm_f64x2_extract_lane(u23, 1);
    double b04 = wasm_f64x2_extract_lane(u45, 0);
    double b05 = wasm_f64x2_extract_lane(u45, 1);
    double b06 = wasm_f64x2_extract_lane(v01, 0);
    double b07 = wasm_f64x2_extract_lane(v01, 1);
    double b08 = wasm_f64x2_extract_lane(v23, 0);
    double b09 = wasm_f64x2_extract_lane(v23, 1);
    double b10 = wasm_f64x2_extract_lane(v45, 0);
    double b11 = wasm_f64x2_extract_lane(v45, 1);

    double det = hsum2(wasm_f64x2_mul(wasm_f64x2_make(b00, b01), wasm_f64x2_make(b11, -b10)))
        + hsum2(wasm_f64x2_mul(wasm_f64x2_make(b02, b03), wasm_f64x2_make(b09, b08)))
        + hsum2(wasm_f64x2_mul(wasm_f64x2_make(b05, b04), wasm_f64x2_make(b06, -b07)));
    if (det == 0.0) {
        return 0;
    }
    det = 1.0 / det;

    store_col_f64(out,
        f64pair_mul_add3(wasm_f64x2_make(m11, -m01), b11, wasm_f64x2_make(-m12, m02), b10, wasm_f64x2_make(m13, -m03), b09, det),
        f64pair_mul_add3(wasm_f64x2_make(m31, -m21), b05, wasm_f64x2_make(-m32, m22), b04, wasm_f64x2_make(m33, -m23), b03, det));
    store_col_f64(out + 4,
        f64pair_mul_add3(wasm_f64x2_make(-m10, m00), b11, wasm_f64x2_make(m12, -m02), b08, wasm_f64x2_make(-m13, m03), b07, det),
        f64pair_mul_add3(wasm_f64x2_make(-m30, m20), b05, wasm_f64x2_make(m32, -m22), b02, wasm_f64x2_make(-m33, m23), b01, det));
    store_col_f64(out + 8,
        f64pair_mul_add3(wasm_f64x2_make(m10, -m00), b10, wasm_f64x2_make(-m11, m01), b08, wasm_f64x2_make(m13, -m03), b06, det),
        f64pair_mul_add3(wasm_f64x2_make(m30, -m20), b04, wasm_f64x2_make(-m31, m21), b02, wasm_f64x2_make(m33, -m23), b00, det));
    store_col_f64(out + 12,
        f64pair_mul_add3(wasm_f64x2_make(-m10, m00), b09, wasm_f64x2_make(m11, -m01), b07, wasm_f64x2_make(-m12, m02), b06, det),
        f64pair_mul_add3(wasm_f64x2_make(-m30, m20), b03, wasm_f64x2_make(m31, -m21), b01, wasm_f64x2_make(-m32, m22), b00, det));
    return 1;
}

static void copy_with_range(void) {
    int32_t n = g_n0;
    float *src = g_src;
    float *dst = g_dest;
    v128_t vmin = wasm_f32x4_splat(1e30f);
    v128_t vmax = wasm_f32x4_splat(0.f);
    int32_t i = 0;
    int32_t n4 = n & ~3;
    for (; i < n4; i += 4) {
        v128_t v = wasm_v128_load(src + i);
        wasm_v128_store(dst + i, v);
        vmin = wasm_f32x4_min(vmin, v);
        vmax = wasm_f32x4_max(vmax, v);
    }
    float mn = hmin4(vmin);
    float mx = hmax4(vmax);
    for (; i < n; i++) {
        float d = src[i];
        dst[i] = d;
        if (d < mn) mn = d;
        if (d > mx) mx = d;
    }
    g_global_min = mn;
    g_global_max = mx;
}

static void scatter_at(int32_t i, float z) {
    if (z < g_dest[i]) {
        g_dest[i] = z;
    }
}

static void scatter_masked(v128_t mask, v128_t z, v128_t nx, v128_t ny) {
    int bits = wasm_i32x4_bitmask(mask);
    if (bits == 0) {
        return;
    }
    v128_t sxk = wasm_f32x4_splat(g_sxk);
    v128_t syk = wasm_f32x4_splat(g_syk);
    v128_t px = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_add(wasm_f32x4_mul(sxk, nx), sxk));
    v128_t py = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_add(wasm_f32x4_mul(syk, ny), syk));
    px = wasm_i32x4_max(wasm_i32x4_min(px, wasm_i32x4_splat(g_last_x)), wasm_i32x4_splat(0));
    py = wasm_i32x4_max(wasm_i32x4_min(py, wasm_i32x4_splat(g_last_y)), wasm_i32x4_splat(0));
    v128_t di = wasm_i32x4_add(wasm_i32x4_mul(py, wasm_i32x4_splat(g_width)), px);
    if (bits & 1) scatter_at(wasm_i32x4_extract_lane(di, 0), wasm_f32x4_extract_lane(z, 0));
    if (bits & 2) scatter_at(wasm_i32x4_extract_lane(di, 1), wasm_f32x4_extract_lane(z, 1));
    if (bits & 4) scatter_at(wasm_i32x4_extract_lane(di, 2), wasm_f32x4_extract_lane(z, 2));
    if (bits & 8) scatter_at(wasm_i32x4_extract_lane(di, 3), wasm_f32x4_extract_lane(z, 3));
}

static v128_t ndc_x0(float step) {
    return wasm_f32x4_make(
        0.5f * step - 1.f,
        1.5f * step - 1.f,
        2.5f * step - 1.f,
        3.5f * step - 1.f);
}

static void scatter_perspective(void) {
    const float *r = reproject_m;
    int32_t w = g_width;
    int32_t h = g_height;
    int32_t w4 = w & ~3;
    float ndc_step_x = 2.f / (float)w;
    float ndc_step_y = 2.f / (float)h;
    g_last_x = w - 1;
    g_last_y = h - 1;
    g_sxk = (float)w * 0.5f;
    g_syk = (float)h * 0.5f;

    float r0 = r[0], r1 = r[1], r3 = r[3];
    float r4 = r[4], r5 = r[5], r7 = r[7];
    float r8 = r[8], r9 = r[9], r11 = r[11];
    float r12 = r[12], r13 = r[13], r15 = r[15];
    float inv_diff_src = 1.f / (g_src_near - g_src_far);
    float a = 2.f * g_src_near * g_src_far * inv_diff_src;
    float b = -2.f * g_src_far * inv_diff_src - 1.f;
    float k_w = r11 * a;
    float k_x = r8 * a;
    float k_y = r9 * a;

    v128_t ndc_base = ndc_x0(ndc_step_x);
    v128_t ndc_step = wasm_f32x4_splat(4.f * ndc_step_x);
    v128_t v1 = wasm_f32x4_splat(1.f);
    v128_t vneg1 = wasm_f32x4_splat(-1.f);
    v128_t v0 = wasm_f32x4_splat(0.f);
    v128_t src_far = wasm_f32x4_splat(g_src_far);
    v128_t dst_near = wasm_f32x4_splat(g_dst_near);
    v128_t dst_far = wasm_f32x4_splat(g_dst_far);
    v128_t vr0 = wasm_f32x4_splat(r0);
    v128_t vr1 = wasm_f32x4_splat(r1);
    v128_t vr3 = wasm_f32x4_splat(r3);
    v128_t vkw = wasm_f32x4_splat(k_w);
    v128_t vkx = wasm_f32x4_splat(k_x);
    v128_t vky = wasm_f32x4_splat(k_y);

    for (int32_t y = 0; y < h; y++) {
        float ndc_y = ((float)y + 0.5f) * ndc_step_y - 1.f;
        int32_t src_row = y * w;
        float cw_y = r7 * ndc_y + r15 + r11 * b;
        float nx_y = r4 * ndc_y + r12 + r8 * b;
        float ny_y = r5 * ndc_y + r13 + r9 * b;
        v128_t vcw_y = wasm_f32x4_splat(cw_y);
        v128_t vnx_y = wasm_f32x4_splat(nx_y);
        v128_t vny_y = wasm_f32x4_splat(ny_y);
        v128_t ndc_x = ndc_base;
        int32_t x = 0;
        for (; x < w4; x += 4) {
            v128_t L = wasm_v128_load(g_src + src_row + x);
            v128_t valid = wasm_v128_and(wasm_f32x4_gt(L, v0), wasm_f32x4_lt(L, src_far));
            v128_t eye_z = wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_mul(vr3, ndc_x), vcw_y), L), vkw);
            valid = wasm_v128_and(valid, wasm_v128_and(wasm_f32x4_gt(eye_z, dst_near), wasm_f32x4_lt(eye_z, dst_far)));
            v128_t inv_z = wasm_f32x4_div(v1, wasm_v128_bitselect(eye_z, v1, valid));
            v128_t nx = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_mul(vr0, ndc_x), vnx_y), L), vkx), inv_z);
            v128_t ny = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_mul(vr1, ndc_x), vny_y), L), vky), inv_z);
            valid = wasm_v128_and(valid,
                wasm_v128_and(
                    wasm_v128_and(wasm_f32x4_ge(nx, vneg1), wasm_f32x4_le(nx, v1)),
                    wasm_v128_and(wasm_f32x4_ge(ny, vneg1), wasm_f32x4_le(ny, v1))));
            scatter_masked(valid, eye_z, nx, ny);
            ndc_x = wasm_f32x4_add(ndc_x, ndc_step);
        }
        for (; x < w; x++) {
            float L = g_src[src_row + x];
            if (!(L > 0.f && L < g_src_far)) {
                continue;
            }
            float ndc = ((float)x + 0.5f) * ndc_step_x - 1.f;
            float eye_z = (r3 * ndc + cw_y) * L + k_w;
            if (!(eye_z > g_dst_near && eye_z < g_dst_far)) {
                continue;
            }
            float inv_z = 1.f / eye_z;
            float nx = ((r0 * ndc + nx_y) * L + k_x) * inv_z;
            float ny = ((r1 * ndc + ny_y) * L + k_y) * inv_z;
            if (nx < -1.f || nx > 1.f || ny < -1.f || ny > 1.f) {
                continue;
            }
            scatter_masked(wasm_i32x4_make(-1, 0, 0, 0), wasm_f32x4_splat(eye_z), wasm_f32x4_splat(nx), wasm_f32x4_splat(ny));
        }
    }
}

static void scatter_generic(void) {
    const float *r = reproject_m;
    int32_t w = g_width;
    int32_t h = g_height;
    int32_t w4 = w & ~3;
    float ndc_step_x = 2.f / (float)w;
    float ndc_step_y = 2.f / (float)h;
    g_last_x = w - 1;
    g_last_y = h - 1;
    g_sxk = (float)w * 0.5f;
    g_syk = (float)h * 0.5f;

    float r0 = r[0], r1 = r[1], r2 = r[2], r3 = r[3];
    float r4 = r[4], r5 = r[5], r6 = r[6], r7 = r[7];
    float r8 = r[8], r9 = r[9], r10 = r[10], r11 = r[11];
    float r12 = r[12], r13 = r[13], r14 = r[14], r15 = r[15];
    float src_range = g_src_far - g_src_near;
    float inv_src_range = src_range == 0.f ? 0.f : 1.f / src_range;
    float nf_src = g_src_near * g_src_far;
    float inv_diff_src = 1.f / (g_src_near - g_src_far);
    float dst_range = g_dst_far - g_dst_near;
    float nf_dst = g_dst_near * g_dst_far;
    float diff_dst = g_dst_near - g_dst_far;

    v128_t ndc_base = ndc_x0(ndc_step_x);
    v128_t ndc_step = wasm_f32x4_splat(4.f * ndc_step_x);
    v128_t v0 = wasm_f32x4_splat(0.f);
    v128_t v1 = wasm_f32x4_splat(1.f);
    v128_t vneg1 = wasm_f32x4_splat(-1.f);
    v128_t v05 = wasm_f32x4_splat(0.5f);
    v128_t veps = wasm_f32x4_splat(NEAR_EPS);
    v128_t src_far = wasm_f32x4_splat(g_src_far);
    v128_t src_near = wasm_f32x4_splat(g_src_near);
    v128_t src_ortho_m = g_src_ortho ? wasm_i32x4_splat(-1) : wasm_i32x4_splat(0);
    v128_t dst_ortho_m = g_dst_ortho ? wasm_i32x4_splat(-1) : wasm_i32x4_splat(0);
    v128_t vr0 = wasm_f32x4_splat(r0);
    v128_t vr1 = wasm_f32x4_splat(r1);
    v128_t vr2 = wasm_f32x4_splat(r2);
    v128_t vr3 = wasm_f32x4_splat(r3);
    v128_t vr8 = wasm_f32x4_splat(r8);
    v128_t vr9 = wasm_f32x4_splat(r9);
    v128_t vr10 = wasm_f32x4_splat(r10);
    v128_t vr11 = wasm_f32x4_splat(r11);

    for (int32_t y = 0; y < h; y++) {
        float ndc_y = ((float)y + 0.5f) * ndc_step_y - 1.f;
        int32_t src_row = y * w;
        float cw_y = r7 * ndc_y + r15;
        float nx_y = r4 * ndc_y + r12;
        float ny_y = r5 * ndc_y + r13;
        float nz_y = r6 * ndc_y + r14;
        v128_t vcw_y = wasm_f32x4_splat(cw_y);
        v128_t vnx_y = wasm_f32x4_splat(nx_y);
        v128_t vny_y = wasm_f32x4_splat(ny_y);
        v128_t vnz_y = wasm_f32x4_splat(nz_y);
        v128_t ndc_x = ndc_base;
        int32_t x = 0;
        for (; x < w4; x += 4) {
            v128_t L = wasm_v128_load(g_src + src_row + x);
            v128_t valid = wasm_v128_and(wasm_f32x4_gt(L, v0), wasm_f32x4_lt(L, src_far));
            v128_t d_ortho = wasm_f32x4_mul(wasm_f32x4_sub(L, src_near), wasm_f32x4_splat(inv_src_range));
            v128_t d_persp = wasm_f32x4_mul(
                wasm_f32x4_sub(wasm_f32x4_div(wasm_f32x4_splat(nf_src), wasm_v128_bitselect(L, v1, valid)), src_far),
                wasm_f32x4_splat(inv_diff_src));
            v128_t depth01 = wasm_v128_bitselect(d_ortho, d_persp, src_ortho_m);
            v128_t z = wasm_f32x4_sub(wasm_f32x4_mul(depth01, wasm_f32x4_splat(2.f)), v1);
            v128_t cw = wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(vr3, ndc_x), wasm_f32x4_mul(vr11, z)), vcw_y);
            valid = wasm_v128_and(valid, wasm_f32x4_gt(cw, veps));
            v128_t inv_cw = wasm_f32x4_div(v1, wasm_v128_bitselect(cw, v1, valid));
            v128_t nx = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(vr0, ndc_x), wasm_f32x4_mul(vr8, z)), vnx_y), inv_cw);
            v128_t ny = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(vr1, ndc_x), wasm_f32x4_mul(vr9, z)), vny_y), inv_cw);
            valid = wasm_v128_and(valid,
                wasm_v128_and(
                    wasm_v128_and(wasm_f32x4_ge(nx, vneg1), wasm_f32x4_le(nx, v1)),
                    wasm_v128_and(wasm_f32x4_ge(ny, vneg1), wasm_f32x4_le(ny, v1))));
            v128_t nz = wasm_f32x4_add(
                wasm_f32x4_mul(
                    wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(vr2, ndc_x), wasm_f32x4_mul(vr10, z)), vnz_y), inv_cw),
                    v05),
                v05);
            valid = wasm_v128_and(valid, wasm_v128_and(wasm_f32x4_gt(nz, v0), wasm_f32x4_lt(nz, v1)));
            v128_t l2o = wasm_f32x4_add(wasm_f32x4_splat(g_dst_near), wasm_f32x4_mul(nz, wasm_f32x4_splat(dst_range)));
            v128_t denom = wasm_f32x4_add(wasm_f32x4_splat(g_dst_far), wasm_f32x4_mul(nz, wasm_f32x4_splat(diff_dst)));
            v128_t l2p = wasm_f32x4_div(wasm_f32x4_splat(nf_dst), wasm_v128_bitselect(denom, v1, valid));
            v128_t l2 = wasm_v128_bitselect(l2o, l2p, dst_ortho_m);
            scatter_masked(valid, l2, nx, ny);
            ndc_x = wasm_f32x4_add(ndc_x, ndc_step);
        }
        for (; x < w; x++) {
            float L = g_src[src_row + x];
            if (!(L > 0.f && L < g_src_far)) {
                continue;
            }
            float depth01 = g_src_ortho
                ? (src_range == 0.f ? 0.f : (L - g_src_near) / src_range)
                : (nf_src / L - g_src_far) * inv_diff_src;
            float z = depth01 * 2.f - 1.f;
            float ndc = ((float)x + 0.5f) * ndc_step_x - 1.f;
            float cw = r3 * ndc + r11 * z + cw_y;
            if (cw <= NEAR_EPS) {
                continue;
            }
            float inv_cw = 1.f / cw;
            float nx = (r0 * ndc + r8 * z + nx_y) * inv_cw;
            float ny = (r1 * ndc + r9 * z + ny_y) * inv_cw;
            if (nx < -1.f || nx > 1.f || ny < -1.f || ny > 1.f) {
                continue;
            }
            float nz = ((r2 * ndc + r10 * z + nz_y) * inv_cw) * 0.5f + 0.5f;
            if (!(nz > 0.f && nz < 1.f)) {
                continue;
            }
            float l2 = g_dst_ortho
                ? g_dst_near + nz * dst_range
                : nf_dst / (g_dst_far + nz * diff_dst);
            scatter_masked(wasm_i32x4_make(-1, 0, 0, 0), wasm_f32x4_splat(l2), wasm_f32x4_splat(nx), wasm_f32x4_splat(ny));
        }
    }
}

static float hole_max_interior(int32_t x, int32_t y, int32_t *found) {
    int32_t w = g_width;
    int32_t x0 = x - 1;
    v128_t ninf = wasm_f32x4_splat(-1e30f);
    v128_t acc = ninf;
    v128_t hit = wasm_i32x4_splat(0);
    v128_t empty = wasm_f32x4_splat(g_dst_far);
    v128_t keep3 = wasm_i32x4_make(-1, -1, -1, 0);
    for (int32_t yy = y - 1; yy <= y + 1; yy++) {
        int32_t row = yy * w + x0;
        v128_t z = wasm_v128_load(g_dest + row);
        v128_t b32 = wasm_u32x4_extend_low_u16x8(wasm_u16x8_extend_low_u8x16(wasm_v128_load32_zero(g_mask + row)));
        v128_t real = wasm_v128_and(keep3, wasm_v128_and(wasm_i32x4_eq(b32, wasm_i32x4_splat(0)), wasm_f32x4_lt(z, empty)));
        acc = wasm_f32x4_max(acc, wasm_v128_bitselect(z, ninf, real));
        hit = wasm_v128_or(hit, real);
    }
    *found = wasm_v128_any_true(hit);
    return hmax4(acc);
}

static float hole_max_border(int32_t x, int32_t y, int32_t *found) {
    int32_t w = g_width;
    int32_t y0 = y > 0 ? y - 1 : 0;
    int32_t y1 = y < g_last_y ? y + 1 : g_last_y;
    int32_t x0 = x > 0 ? x - 1 : 0;
    int32_t x1 = x < g_last_x ? x + 1 : g_last_x;
    float empty = g_dst_far;
    float m = 0.f;
    int f = 0;
    for (int32_t yy = y0; yy <= y1; yy++) {
        int32_t row = yy * w;
        for (int32_t xx = x0; xx <= x1; xx++) {
            int32_t j = row + xx;
            if (g_mask[j] != 0) {
                continue;
            }
            float z = g_dest[j];
            if (z < empty) {
                f = 1;
                if (z > m) m = z;
            }
        }
    }
    *found = f;
    return m;
}

static void fill_holes(void) {
    int32_t w = g_width;
    int32_t h = g_height;
    int32_t n = w * h;
    float empty = g_dst_far;
    float mn = 1e30f;
    float mx = 0.f;

    if (w < 2 || h < 2) {
        for (int32_t i = 0; i < n; i++) {
            float d = g_dest[i];
            if (d < mn) mn = d;
            if (d > mx) mx = d;
        }
        g_global_min = mn;
        g_global_max = mx;
        return;
    }

    int32_t hole_count = 0;
    v128_t empty_v = wasm_f32x4_splat(empty);
    v128_t inf_v = wasm_f32x4_splat(1e30f);
    v128_t zero_v = wasm_f32x4_splat(0.f);
    v128_t vmin = inf_v;
    v128_t vmax = zero_v;
    int32_t i = 0;
    int32_t n4 = n & ~3;
    for (; i < n4; i += 4) {
        v128_t v = wasm_v128_load(g_dest + i);
        v128_t real = wasm_f32x4_lt(v, empty_v);
        v128_t hole = wasm_v128_not(real);
        vmin = wasm_f32x4_min(vmin, wasm_v128_bitselect(v, inf_v, real));
        vmax = wasm_f32x4_max(vmax, wasm_v128_bitselect(v, zero_v, real));
        int bits = wasm_i32x4_bitmask(hole);
        uint32_t packed = (uint32_t)(bits & 1)
            | ((uint32_t)((bits >> 1) & 1) << 8)
            | ((uint32_t)((bits >> 2) & 1) << 16)
            | ((uint32_t)((bits >> 3) & 1) << 24);
        *(uint32_t *)(g_mask + i) = packed;
        if (bits & 1) g_holes[hole_count++] = i;
        if (bits & 2) g_holes[hole_count++] = i + 1;
        if (bits & 4) g_holes[hole_count++] = i + 2;
        if (bits & 8) g_holes[hole_count++] = i + 3;
    }
    mn = hmin4(vmin);
    mx = hmax4(vmax);
    for (; i < n; i++) {
        float d = g_dest[i];
        if (d < empty) {
            g_mask[i] = 0;
            if (d < mn) mn = d;
            if (d > mx) mx = d;
        } else {
            g_mask[i] = 1;
            g_holes[hole_count++] = i;
        }
    }

    if (hole_count == 0) {
        g_global_min = mn;
        g_global_max = mx;
        return;
    }

    int32_t last_x = w - 1;
    int32_t last_y = h - 1;
    g_last_x = last_x;
    g_last_y = last_y;
    for (int32_t k = 0; k < hole_count; k++) {
        int32_t idx = g_holes[k];
        int32_t y = idx / w;
        int32_t x = idx - y * w;
        int found;
        float m = (x >= 1 && y >= 1 && x < last_x && y < last_y)
            ? hole_max_interior(x, y, &found)
            : hole_max_border(x, y, &found);
        float d = found ? m : empty;
        g_dest[idx] = d;
        if (d < mn) mn = d;
        if (d > mx) mx = d;
    }
    g_global_min = mn;
    g_global_max = mx;
}

static void reproject(void) {
    if (!invert16(inv_m, src_vp)) {
        copy_with_range();
        return;
    }
    mul16(reproject_m, dst_vp, inv_m);
    fill_f32(g_dest, g_n0, g_dst_far);
    if (g_src_ortho || g_dst_ortho) {
        scatter_generic();
    } else {
        scatter_perspective();
    }
    fill_holes();
}

static int32_t unit_to_pixel(double u, int32_t size) {
    if (u < 0.0) u = 0.0;
    else if (u > 1.0) u = 1.0;
    return (int32_t)(u * (double)size);
}

static int32_t unit_to_pixel_end(double u, int32_t size) {
    if (u < 0.0) u = 0.0;
    else if (u > 1.0) u = 1.0;
    double r = u * (double)size;
    int32_t i = (int32_t)r;
    return ((double)i == r ? i : i + 1) - 1;
}

static int32_t clamp_i(int32_t v, int32_t hi) {
    if (v > hi) return hi;
    if (v < 0) return 0;
    return v;
}

static void rect_walk_bounds(int32_t *x0, int32_t *y0, int32_t *x1, int32_t *y1) {
    int32_t last_x = g_width - 1;
    int32_t last_y = g_height - 1;
    *x0 = clamp_i(*x0, last_x);
    *y0 = clamp_i(*y0, last_y);
    *x1 = clamp_i(*x1, last_x);
    *y1 = clamp_i(*y1, last_y);
    if (*x1 < *x0) *x1 = *x0;
    if (*y1 < *y0) *y1 = *y0;
}

static float rect_depth(int32_t x0, int32_t y0, int32_t x1, int32_t y1, int want_max) {
    rect_walk_bounds(&x0, &y0, &x1, &y1);
    int32_t w = g_width;
    v128_t acc = want_max ? wasm_f32x4_splat(-1e30f) : wasm_f32x4_splat(1e30f);
    float m = want_max ? -1e30f : 1e30f;

    for (int32_t y = y0; y <= y1; y++) {
        int32_t index = y * w + x0;
        int32_t end = index + (x1 - x0);
        while (index <= end && (index & 3)) {
            float d = g_dest[index++];
            if (want_max) {
                if (d > m) m = d;
            } else if (d < m) {
                m = d;
            }
        }
        int32_t aligned_end = end - ((end - index + 1) & 3);
        for (; index <= aligned_end; index += 4) {
            v128_t v = wasm_v128_load(g_dest + index);
            acc = want_max ? wasm_f32x4_max(acc, v) : wasm_f32x4_min(acc, v);
        }
        for (; index <= end; index++) {
            float d = g_dest[index];
            if (want_max) {
                if (d > m) m = d;
            } else if (d < m) {
                m = d;
            }
        }
    }
    if (want_max) {
        float a = hmax4(acc);
        if (a > m) m = a;
    } else {
        float a = hmin4(acc);
        if (a < m) m = a;
    }
    return m;
}

static int rect_occluded(float ndc_min_x, float ndc_min_y, float ndc_max_x, float ndc_max_y, float min_z) {
    int32_t w = g_width;
    int32_t h = g_height;
    int32_t last_x = w - 1;
    int32_t last_y = h - 1;
    int32_t x0 = unit_to_pixel(ndc_min_x * 0.5 + 0.5, w);
    int32_t y0 = unit_to_pixel(ndc_min_y * 0.5 + 0.5, h);
    int32_t x1 = unit_to_pixel_end(ndc_max_x * 0.5 + 0.5, w);
    int32_t y1 = unit_to_pixel_end(ndc_max_y * 0.5 + 0.5, h);
    if (x0 > last_x) x0 = last_x;
    if (y0 > last_y) y0 = last_y;
    if (x1 > last_x) x1 = last_x;
    if (y1 > last_y) y1 = last_y;
    if (x1 < x0) x1 = x0;
    if (y1 < y0) y1 = y0;
    if (g_rect_pad > 0) {
        x0 -= g_rect_pad;
        y0 -= g_rect_pad;
        x1 += g_rect_pad;
        y1 += g_rect_pad;
        if (x0 < 0) x0 = 0;
        if (y0 < 0) y0 = 0;
        if (x1 > last_x) x1 = last_x;
        if (y1 > last_y) y1 = last_y;
    }
    v128_t min_zv = wasm_f32x4_splat(min_z);
    for (int32_t y = y0; y <= y1; y++) {
        int32_t index = y * w + x0;
        int32_t end = index + (x1 - x0);
        while (index <= end && (index & 3)) {
            if (g_dest[index++] > min_z) {
                return 0;
            }
        }
        int32_t aligned_end = end - ((end - index + 1) & 3);
        for (; index <= aligned_end; index += 4) {
            v128_t v = wasm_v128_load(g_dest + index);
            if (wasm_v128_any_true(wasm_f32x4_gt(v, min_zv))) {
                return 0;
            }
        }
        for (; index <= end; index++) {
            if (g_dest[index] > min_z) {
                return 0;
            }
        }
    }
    return 1;
}

static void aabb_eye_range(float cx, float cy, float cz, float hx, float hy, float hz) {
    v128_t vz = wasm_f32x4_make(view_m[2], view_m[6], view_m[10], view_m[14]);
    float c = -hsum4(wasm_f32x4_mul(vz, wasm_f32x4_make(cx, cy, cz, 1.f)));
    float rr = hsum4(wasm_f32x4_mul(wasm_f32x4_abs(vz), wasm_f32x4_make(hx, hy, hz, 0.f)));
    g_min_eye = c - rr;
    g_max_eye = c + rr;
}

static int clip4(v128_t d0, v128_t d1, float *t0, float *t1) {
    v128_t z = wasm_f32x4_splat(0.f);
    v128_t n0 = wasm_f32x4_lt(d0, z);
    v128_t n1 = wasm_f32x4_lt(d1, z);
    if (wasm_v128_any_true(wasm_v128_and(n0, n1))) {
        return 0;
    }
    v128_t den = wasm_f32x4_sub(d0, d1);
    v128_t t = wasm_f32x4_div(d0, wasm_v128_bitselect(den, wasm_f32x4_splat(1.f), wasm_f32x4_ne(den, z)));
    v128_t enter = wasm_v128_and(n0, wasm_v128_not(n1));
    v128_t leave = wasm_v128_and(wasm_v128_not(n0), n1);
    float et = hmax4(wasm_v128_bitselect(t, z, enter));
    float lt = hmin4(wasm_v128_bitselect(t, wasm_f32x4_splat(1.f), leave));
    if (et > *t0) *t0 = et;
    if (lt < *t1) *t1 = lt;
    return *t0 <= *t1;
}

static void add_clipped_points(float x0, float y0, float w0, float x1, float y1, float w1, float t0, float t1) {
    v128_t t = wasm_f32x4_make(t0, t1, t0, t1);
    v128_t x = wasm_f32x4_add(wasm_f32x4_splat(x0), wasm_f32x4_mul(wasm_f32x4_splat(x1 - x0), t));
    v128_t y = wasm_f32x4_add(wasm_f32x4_splat(y0), wasm_f32x4_mul(wasm_f32x4_splat(y1 - y0), t));
    v128_t w = wasm_f32x4_add(wasm_f32x4_splat(w0), wasm_f32x4_mul(wasm_f32x4_splat(w1 - w0), t));
    v128_t ok = wasm_f32x4_gt(w, wasm_f32x4_splat(NEAR_EPS));
    v128_t inv = wasm_f32x4_div(wasm_f32x4_splat(1.f), wasm_v128_bitselect(w, wasm_f32x4_splat(1.f), ok));
    v128_t nx = wasm_f32x4_mul(x, inv);
    v128_t ny = wasm_f32x4_mul(y, inv);
    v128_t inf = wasm_f32x4_splat(1e30f);
    v128_t ninf = wasm_f32x4_splat(-1e30f);
    float minx = hmin4(wasm_v128_bitselect(nx, inf, ok));
    float miny = hmin4(wasm_v128_bitselect(ny, inf, ok));
    float maxx = hmax4(wasm_v128_bitselect(nx, ninf, ok));
    float maxy = hmax4(wasm_v128_bitselect(ny, ninf, ok));
    if (minx < g_min_x) g_min_x = minx;
    if (miny < g_min_y) g_min_y = miny;
    if (maxx > g_max_x) g_max_x = maxx;
    if (maxy > g_max_y) g_max_y = maxy;
}

static void add_edge(int i0, int i1) {
    float x0 = g_cx[i0], y0 = g_cy[i0], z0 = g_cz[i0], w0 = g_cw[i0];
    float x1 = g_cx[i1], y1 = g_cy[i1], z1 = g_cz[i1], w1 = g_cw[i1];
    float t0 = 0.f;
    float t1 = 1.f;
    v128_t d0a = wasm_f32x4_make(w0 - NEAR_EPS, x0 + w0, w0 - x0, y0 + w0);
    v128_t d1a = wasm_f32x4_make(w1 - NEAR_EPS, x1 + w1, w1 - x1, y1 + w1);
    v128_t d0b = wasm_f32x4_make(w0 - y0, z0 + w0, w0 - z0, 1.f);
    v128_t d1b = wasm_f32x4_make(w1 - y1, z1 + w1, w1 - z1, 1.f);
    if (!clip4(d0a, d1a, &t0, &t1)) return;
    if (!clip4(d0b, d1b, &t0, &t1)) return;
    add_clipped_points(x0, y0, w0, x1, y1, w1, t0, t1);
}

static int project_aabb(float cx, float cy, float cz, float hx, float hy, float hz) {
    v128_t col0 = wasm_v128_load(test_vp);
    v128_t col1 = wasm_v128_load(test_vp + 4);
    v128_t col2 = wasm_v128_load(test_vp + 8);
    v128_t col3 = wasm_v128_load(test_vp + 12);
    v128_t ec = madd(madd(madd(wasm_f32x4_mul(col0, wasm_f32x4_splat(cx)), col1, cy), col2, cz), col3, 1.f);
    v128_t a = wasm_f32x4_mul(col0, wasm_f32x4_splat(hx));
    v128_t b = wasm_f32x4_mul(col1, wasm_f32x4_splat(hy));
    v128_t d = wasm_f32x4_mul(col2, wasm_f32x4_splat(hz));

    float ecx = wasm_f32x4_extract_lane(ec, 0);
    float ecy = wasm_f32x4_extract_lane(ec, 1);
    float ecz = wasm_f32x4_extract_lane(ec, 2);
    float ecw = wasm_f32x4_extract_lane(ec, 3);
    float ax = wasm_f32x4_extract_lane(a, 0), ay = wasm_f32x4_extract_lane(a, 1);
    float az = wasm_f32x4_extract_lane(a, 2), aw = wasm_f32x4_extract_lane(a, 3);
    float bx = wasm_f32x4_extract_lane(b, 0), by = wasm_f32x4_extract_lane(b, 1);
    float bz = wasm_f32x4_extract_lane(b, 2), bw = wasm_f32x4_extract_lane(b, 3);
    float dx = wasm_f32x4_extract_lane(d, 0), dy = wasm_f32x4_extract_lane(d, 1);
    float dz = wasm_f32x4_extract_lane(d, 2), dw = wasm_f32x4_extract_lane(d, 3);

    v128_t sx = wasm_f32x4_make(-1.f, 1.f, -1.f, 1.f);
    v128_t sy = wasm_f32x4_make(-1.f, -1.f, 1.f, 1.f);
    v128_t z0 = wasm_f32x4_splat(0.f);
    v128_t eps = wasm_f32x4_splat(NEAR_EPS);
    v128_t inf = wasm_f32x4_splat(1e30f);
    v128_t ninf = wasm_f32x4_splat(-1e30f);
    v128_t one = wasm_i32x4_splat(1);
    int and_out = 127;
    int inside = 0;
    v128_t nxmin = inf;
    v128_t nymin = inf;
    v128_t nxmax = ninf;
    v128_t nymax = ninf;

    for (int pass = 0; pass < 2; pass++) {
        v128_t sz = wasm_f32x4_splat(pass ? 1.f : -1.f);
        v128_t x = wasm_f32x4_add(wasm_f32x4_splat(ecx),
            wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(sx, wasm_f32x4_splat(ax)), wasm_f32x4_mul(sy, wasm_f32x4_splat(bx))),
                wasm_f32x4_mul(sz, wasm_f32x4_splat(dx))));
        v128_t y = wasm_f32x4_add(wasm_f32x4_splat(ecy),
            wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(sx, wasm_f32x4_splat(ay)), wasm_f32x4_mul(sy, wasm_f32x4_splat(by))),
                wasm_f32x4_mul(sz, wasm_f32x4_splat(dy))));
        v128_t z = wasm_f32x4_add(wasm_f32x4_splat(ecz),
            wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(sx, wasm_f32x4_splat(az)), wasm_f32x4_mul(sy, wasm_f32x4_splat(bz))),
                wasm_f32x4_mul(sz, wasm_f32x4_splat(dz))));
        v128_t ww = wasm_f32x4_add(wasm_f32x4_splat(ecw),
            wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(sx, wasm_f32x4_splat(aw)), wasm_f32x4_mul(sy, wasm_f32x4_splat(bw))),
                wasm_f32x4_mul(sz, wasm_f32x4_splat(dw))));

        wasm_v128_store(g_cx + (pass << 2), x);
        wasm_v128_store(g_cy + (pass << 2), y);
        wasm_v128_store(g_cz + (pass << 2), z);
        wasm_v128_store(g_cw + (pass << 2), ww);

        v128_t oc = wasm_v128_and(wasm_f32x4_le(ww, eps), one);
        oc = wasm_v128_or(oc, wasm_v128_and(wasm_f32x4_lt(wasm_f32x4_add(x, ww), z0), wasm_i32x4_splat(2)));
        oc = wasm_v128_or(oc, wasm_v128_and(wasm_f32x4_lt(wasm_f32x4_sub(ww, x), z0), wasm_i32x4_splat(4)));
        oc = wasm_v128_or(oc, wasm_v128_and(wasm_f32x4_lt(wasm_f32x4_add(y, ww), z0), wasm_i32x4_splat(8)));
        oc = wasm_v128_or(oc, wasm_v128_and(wasm_f32x4_lt(wasm_f32x4_sub(ww, y), z0), wasm_i32x4_splat(16)));
        oc = wasm_v128_or(oc, wasm_v128_and(wasm_f32x4_lt(wasm_f32x4_add(z, ww), z0), wasm_i32x4_splat(32)));
        oc = wasm_v128_or(oc, wasm_v128_and(wasm_f32x4_lt(wasm_f32x4_sub(ww, z), z0), wasm_i32x4_splat(64)));

        and_out &= wasm_i32x4_extract_lane(oc, 0) & wasm_i32x4_extract_lane(oc, 1)
            & wasm_i32x4_extract_lane(oc, 2) & wasm_i32x4_extract_lane(oc, 3);
        v128_t ins = wasm_i32x4_eq(oc, wasm_i32x4_splat(0));
        inside |= wasm_i32x4_bitmask(ins) << (pass << 2);

        v128_t inv = wasm_f32x4_div(wasm_f32x4_splat(1.f), wasm_v128_bitselect(ww, wasm_f32x4_splat(1.f), ins));
        v128_t nx = wasm_f32x4_mul(x, inv);
        v128_t ny = wasm_f32x4_mul(y, inv);
        nxmin = wasm_f32x4_min(nxmin, wasm_v128_bitselect(nx, inf, ins));
        nymin = wasm_f32x4_min(nymin, wasm_v128_bitselect(ny, inf, ins));
        nxmax = wasm_f32x4_max(nxmax, wasm_v128_bitselect(nx, ninf, ins));
        nymax = wasm_f32x4_max(nymax, wasm_v128_bitselect(ny, ninf, ins));
    }

    if (and_out != 0) {
        return 0;
    }
    g_min_x = hmin4(nxmin);
    g_min_y = hmin4(nymin);
    g_max_x = hmax4(nxmax);
    g_max_y = hmax4(nymax);
    if (inside == 255) {
        return 1;
    }
    for (int e = 0; e < 12; e++) {
        int ia = EDGE0[e];
        int ib = EDGE1[e];
        if ((inside & (1 << ia)) && (inside & (1 << ib))) {
            continue;
        }
        add_edge(ia, ib);
    }
    return g_min_x <= g_max_x;
}

WASM_EXPORT("resize")
void resize(int32_t w, int32_t h) {
    if (w == g_width && h == g_height && g_n0 > 0) {
        return;
    }
    g_width = w;
    g_height = h;
    relayout_keep_aabbs(w * h, g_aabb_cap);
    if (g_n0 > 0) {
        fill_f32(g_dest, g_n0, 1e10f);
    }
    g_has_src = 0;
    g_built = 0;
}

WASM_EXPORT("resize_aabbs")
void resize_aabbs(int32_t cap) {
    if (cap < 0) {
        cap = 0;
    }
    if (cap == g_aabb_cap && (cap == 0 || g_flags)) {
        return;
    }
    relayout_keep_aabbs(g_n0, cap);
}

WASM_EXPORT("on_set_source")
void on_set_source(void) {
    g_src_far = src_params[1];
    g_src_near = src_params[2];
    g_src_ortho = src_params[3] != 0.f;
    g_has_src = 1;
    g_built = 0;
}

WASM_EXPORT("update")
void update(double cam_x, double cam_y, double cam_z) {
    g_cam_x = cam_x;
    g_cam_y = cam_y;
    g_cam_z = cam_z;
    g_dst_far = dst_params[1];
    g_dst_near = dst_params[2];
    g_dst_ortho = dst_params[3] != 0.f;
    if (!g_has_src || g_n0 <= 0) {
        return;
    }
    if (g_built && eq16(dst_vp, in_dst_vp)) {
        return;
    }
    copy16(dst_vp, in_dst_vp);
    if (eq16(src_vp, in_dst_vp)) {
        copy_with_range();
    } else {
        reproject();
    }
    g_built = 1;
}

static int32_t test_aabb_f32(float cx0, float cy0, float cz0, float hx0, float hy0, float hz0) {
    if (!g_built) {
        return VISIBLE;
    }
    v128_t cam = wasm_f32x4_make((float)g_cam_x, (float)g_cam_y, (float)g_cam_z, 0.f);
    v128_t c = wasm_f32x4_make(cx0, cy0, cz0, 0.f);
    v128_t h = wasm_f32x4_make(hx0, hy0, hz0, 0.f);
    v128_t d = wasm_f32x4_sub(wasm_f32x4_abs(wasm_f32x4_sub(cam, c)), h);
    v128_t ex = wasm_f32x4_max(d, wasm_f32x4_splat(0.f));
    float expand = 0.f;
    if (g_aabb_expand > 0.0) {
        expand = (float)g_aabb_expand * wasm_f32x4_extract_lane(
            wasm_f32x4_sqrt(wasm_f32x4_splat(hsum4(wasm_f32x4_mul(ex, ex)))), 0);
        h = wasm_f32x4_add(h, wasm_f32x4_splat(expand));
    }
    if ((wasm_i32x4_bitmask(wasm_f32x4_le(d, wasm_f32x4_splat(expand))) & 7) == 7) {
        return VISIBLE;
    }
    float cx = wasm_f32x4_extract_lane(c, 0);
    float cy = wasm_f32x4_extract_lane(c, 1);
    float cz = wasm_f32x4_extract_lane(c, 2);
    float hx = wasm_f32x4_extract_lane(h, 0);
    float hy = wasm_f32x4_extract_lane(h, 1);
    float hz = wasm_f32x4_extract_lane(h, 2);
    aabb_eye_range(cx, cy, cz, hx, hy, hz);
    float min_eye = g_min_eye;
    float max_eye = g_max_eye;
    if (min_eye < g_dst_near) {
        min_eye = g_dst_near;
    }
    if (min_eye >= g_dst_far) {
        return VISIBLE;
    }
    if (min_eye > g_global_max) {
        return OCCLUDED;
    }
    if (max_eye < g_global_min) {
        return VISIBLE;
    }
    if (!project_aabb(cx, cy, cz, hx, hy, hz)) {
        return VISIBLE;
    }
    if (g_max_x < -1.f || g_min_x > 1.f || g_max_y < -1.f || g_min_y > 1.f) {
        return VISIBLE;
    }
    return rect_occluded(g_min_x, g_min_y, g_max_x, g_max_y, min_eye) ? OCCLUDED : VISIBLE;
}

WASM_EXPORT("test_aabb")
int32_t test_aabb(double cx0, double cy0, double cz0, double hx0, double hy0, double hz0) {
    return test_aabb_f32((float)cx0, (float)cy0, (float)cz0, (float)hx0, (float)hy0, (float)hz0);
}

WASM_EXPORT("test_queue")
void test_queue(int32_t count) {
    int32_t cap = g_aabb_cap;
    if (!g_flags || cap <= 0) {
        return;
    }
    if (count <= 0 || !g_built) {
        fill_i8(g_flags, cap, (int8_t)UNKNOWN);
        return;
    }
    if (count > cap) {
        count = cap;
    }
    const int32_t *queue = g_queue;
    const float *centers = g_centers;
    const float *halves = g_halves;
    int8_t *flags = g_flags;
    for (int32_t i = 0; i < count; i++) {
        int32_t id = queue[i];
        if ((uint32_t)id < (uint32_t)cap) {
            int32_t base = id << 2;
            flags[id] = (int8_t)test_aabb_f32(
                centers[base], centers[base + 1], centers[base + 2],
                halves[base], halves[base + 1], halves[base + 2]);
        }
    }
}

WASM_EXPORT("fill_flags")
void fill_flags(int32_t value) {
    fill_i8(g_flags, g_aabb_cap, (int8_t)value);
}

WASM_EXPORT("set_flags_write_slot")
void set_flags_write_slot(int32_t slot) {
    g_flags = slot ? g_flags1 : g_flags0;
}

WASM_EXPORT("flags0_ptr")
int32_t flags0_ptr(void) {
    return (int32_t)(uintptr_t)g_flags0;
}

WASM_EXPORT("flags1_ptr")
int32_t flags1_ptr(void) {
    return (int32_t)(uintptr_t)g_flags1;
}

WASM_EXPORT("depth_uv")
float depth_uv(double u0, double v0, double u1, double v1, int32_t want_max) {
    if (!g_built || g_n0 <= 0) {
        return g_dst_far;
    }
    if (u1 < u0) {
        double t = u0; u0 = u1; u1 = t;
    }
    if (v1 < v0) {
        double t = v0; v0 = v1; v1 = t;
    }
    if (u1 < 0.0 || v1 < 0.0 || u0 > 1.0 || v0 > 1.0) {
        return g_dst_far;
    }
    if (u0 < 0.0) u0 = 0.0;
    if (v0 < 0.0) v0 = 0.0;
    if (u1 > 1.0) u1 = 1.0;
    if (v1 > 1.0) v1 = 1.0;
    return rect_depth(
        unit_to_pixel(u0, g_width),
        unit_to_pixel(v0, g_height),
        unit_to_pixel_end(u1, g_width),
        unit_to_pixel_end(v1, g_height),
        want_max);
}

WASM_EXPORT("depth_pixels")
float depth_pixels(int32_t x0, int32_t y0, int32_t x1, int32_t y1, int32_t want_max) {
    if (!g_built || g_n0 <= 0) {
        return g_dst_far;
    }
    if (x1 < x0) {
        int32_t t = x0; x0 = x1; x1 = t;
    }
    if (y1 < y0) {
        int32_t t = y0; y0 = y1; y1 = t;
    }
    int32_t last_x = g_width - 1;
    int32_t last_y = g_height - 1;
    if (x1 < 0 || y1 < 0 || x0 > last_x || y0 > last_y) {
        return g_dst_far;
    }
    return rect_depth(x0, y0, x1, y1, want_max);
}

WASM_EXPORT("set_aabb_expand") void set_aabb_expand(double v) { g_aabb_expand = v; }
WASM_EXPORT("get_aabb_expand") double get_aabb_expand(void) { return g_aabb_expand; }
WASM_EXPORT("set_rect_pad") void set_rect_pad(int32_t v) { g_rect_pad = v; }
WASM_EXPORT("get_rect_pad") int32_t get_rect_pad(void) { return g_rect_pad; }
WASM_EXPORT("src_ptr") int32_t src_ptr(void) { return (int32_t)(uintptr_t)g_src; }
WASM_EXPORT("dest_ptr") int32_t dest_ptr(void) { return (int32_t)(uintptr_t)g_dest; }
WASM_EXPORT("src_vp_ptr") int32_t src_vp_ptr(void) { return (int32_t)(uintptr_t)src_vp; }
WASM_EXPORT("src_params_ptr") int32_t src_params_ptr(void) { return (int32_t)(uintptr_t)src_params; }
WASM_EXPORT("dst_params_ptr") int32_t dst_params_ptr(void) { return (int32_t)(uintptr_t)dst_params; }
WASM_EXPORT("view_ptr") int32_t view_ptr(void) { return (int32_t)(uintptr_t)view_m; }
WASM_EXPORT("test_vp_ptr") int32_t test_vp_ptr(void) { return (int32_t)(uintptr_t)test_vp; }
WASM_EXPORT("in_dst_vp_ptr") int32_t in_dst_vp_ptr(void) { return (int32_t)(uintptr_t)in_dst_vp; }
WASM_EXPORT("n0") int32_t n0(void) { return g_n0; }
WASM_EXPORT("width") int32_t width(void) { return g_width; }
WASM_EXPORT("height") int32_t height(void) { return g_height; }
WASM_EXPORT("built") int32_t built(void) { return g_built; }
WASM_EXPORT("far_clip") float far_clip(void) { return g_dst_far; }
WASM_EXPORT("centers_ptr") int32_t centers_ptr(void) { return (int32_t)(uintptr_t)g_centers; }
WASM_EXPORT("halves_ptr") int32_t halves_ptr(void) { return (int32_t)(uintptr_t)g_halves; }
WASM_EXPORT("queue_ptr") int32_t queue_ptr(void) { return (int32_t)(uintptr_t)g_queue; }
WASM_EXPORT("flags_ptr") int32_t flags_ptr(void) { return (int32_t)(uintptr_t)g_flags; }
WASM_EXPORT("aabb_cap") int32_t aabb_cap(void) { return g_aabb_cap; }
