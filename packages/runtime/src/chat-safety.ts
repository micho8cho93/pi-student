/** Narrow, local review signals. No message text is retained or uploaded. */
export function chatSafetyCategories(text:string):string[]{
 const normalized=text.toLowerCase().replace(/[’]/g,"'");
 const categories:string[]=[];
 if(/\b(?:i (?:am going to|plan to|want to|will)|i'm going to) (?:kill|hurt) myself\b/.test(normalized))categories.push('self_harm_intent');
 if(/\b(?:i (?:am going to|plan to|will)|i'm going to) (?:kill|shoot|stab) (?:you|him|her|them|my teacher|my classmates)\b/.test(normalized))categories.push('threat_of_violence');
 return categories;
}
