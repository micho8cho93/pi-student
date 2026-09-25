import {expect,it} from 'vitest';
import {chatSafetyCategories} from '../src/chat-safety.js';
it('emits narrow review categories without retaining text',()=>{
 expect(chatSafetyCategories('I am going to hurt myself')).toEqual(['self_harm_intent']);
 expect(chatSafetyCategories('I will shoot my classmates')).toEqual(['threat_of_violence']);
 expect(chatSafetyCategories('Discuss violence in Macbeth and how to prevent self-harm.')).toEqual([]);
 expect(chatSafetyCategories('Kill the running process')).toEqual([]);
});
