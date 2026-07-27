export function applyHardGuards(result) {
  const {owned,product}=result.items;
  const conflicts=[];
  let cap=100;
  if(owned.category!=='unknown'&&owned.category===product.category&&['top','bottom','outer','dress'].includes(owned.category)){
    cap=Math.min(cap,35); conflicts.push('두 아이템의 카테고리가 겹쳐 보완 관계가 아닙니다.');
  }
  if(new Set([owned.season,product.season]).size===2&&['summer','winter'].includes(owned.season)&&['summer','winter'].includes(product.season)){
    cap=Math.min(cap,54); conflicts.push('여름용과 겨울용 아이템이 충돌합니다.');
  }
  if(['male','female'].includes(owned.gender)&&['male','female'].includes(product.gender)&&owned.gender!==product.gender){
    cap=Math.min(cap,49); conflicts.push('두 아이템의 주요 착용 대상이 다릅니다.');
  }
  if(Math.abs(owned.formality-product.formality)===2){
    cap=Math.min(cap,56); conflicts.push('두 아이템의 격식도가 크게 다릅니다.');
  }
  result.hard_conflicts=[...new Set([...result.hard_conflicts,...conflicts])];
  result.score=Math.max(0,Math.min(result.score,cap)-Math.max(0,conflicts.length-1)*10);
  result.verdict=result.score>=78?'추천':result.score>=60?'조건부 추천':result.score>=45?'신중 추천':'비추천';
  return result;
}
