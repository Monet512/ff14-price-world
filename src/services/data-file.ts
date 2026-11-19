/**
 * 随包数据文件定位。
 *
 * 背景：扩展以 pnpm link 方式安装，运行时 import.meta.url 指向真实包目录
 * （通常是 <package>/src/services/），data/ 在包根。
 * 注意不要用 ctx.packageDir——在 Coo 运行时它指向 cormini bot 包目录，不是扩展目录。
 *
 * 策略：从本文件所在目录出发逐级向上找 data/<name>，命中即返回；
 * 这样无论源码直接在包内、还是被搬到 build/dist 子目录，都能定位到随包数据。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从 services/ 出发向上最多找 5 级，返回第一个存在的 data/<name> 绝对路径。 */
export function findDataFile(name: string): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'data', name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
