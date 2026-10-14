import sys
src, dst, *extra = sys.argv[1:]
drop = ['"t1"', '"t2"', '"+"', '"Close terminal"', '"Remote workspace terminal"']
lines = [l for l in open(src).read().splitlines() if not any(t in l for t in drop)]
open(dst, "w").write("\n".join(lines + extra) + "\n")
