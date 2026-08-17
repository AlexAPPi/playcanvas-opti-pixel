export const SO_STATUS_IDLE = 0;
export const SO_STATUS_WORK = 1;
export const SO_STATUS_DONE = 2;
export const SO_STATUS_EXIT = 3;

export const SO_I32_STATUS = 0;
export const SO_I32_WRITE_SLOT = 1;
export const SO_I32_QUEUE_COUNT = 3;
export const SO_I32_TIME_CLEAR_US = 4;
export const SO_I32_TIME_RASTER_US = 5;
export const SO_I32_TIME_HIZ_US = 6;
export const SO_I32_TIME_AABB_US = 7;
export const SO_I32_TIME_TOTAL_US = 8;
export const SO_I32_STAT_OCCLUDERS = 9;
export const SO_I32_STAT_AABB = 10;
export const SO_I32_STAT_OCCLUDED = 11;
export const SO_I32_STAT_VISIBLE = 12;

export const SO_OCCLUDER_BOX = 1;
export const SO_OCCLUDER_PLANE = 2;
export const SO_OCCLUDER_CYLINDER = 3;
export const SO_OCCLUDER_CONE = 4;
export const SO_OCCLUDER_SPHERE = 5;
export const SO_OCCLUDER_MESH = 6;

export const SO_FLAG_UNKNOWN = 0;
export const SO_FLAG_OCCLUDED = 1;
export const SO_FLAG_VISIBLE = 2;

export const SO_CONTROL_I32_COUNT = 16;
export const SO_OCCLUDER_STRIDE = 16;
export const SO_MESH_RANGE_STRIDE = 4;
export const SO_AABB_STRIDE = 4;
export const SO_DEFAULT_MESH_VERTEX_CAPACITY = 65536 * 3;
export const SO_DEFAULT_MESH_INDEX_CAPACITY = 65536 * 6;
