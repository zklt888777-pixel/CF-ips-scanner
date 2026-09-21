// EXPORTS: INode, MOCK_NODES, getTopNodesByCountry
import rawNodes from './nodes.json';

export interface INode {
  ip: string;
  port: number;
  code: string;
  latency: number;
  city: string;
  country: string;
}

export const MOCK_NODES: INode[] = rawNodes as INode[];

/**
 * 按国家分组，每个国家取延迟最小的前 N 个节点
 */
export function getTopNodesByCountry(
  nodes: INode[],
  topN = 4,
): { country: string; nodes: INode[] }[] {
  const groups = new Map<string, INode[]>();
  for (const node of nodes) {
    const list = groups.get(node.country) ?? [];
    list.push(node);
    groups.set(node.country, list);
  }

  const result: { country: string; nodes: INode[] }[] = [];
  for (const [country, list] of groups) {
    const sorted = [...list].sort((a, b) => a.latency - b.latency);
    result.push({
      country,
      nodes: sorted.slice(0, topN),
    });
  }

  // 按每个国家的最低延迟排序（速度最快的国家排在前面）
  result.sort((a, b) => a.nodes[0].latency - b.nodes[0].latency);
  return result;
}
