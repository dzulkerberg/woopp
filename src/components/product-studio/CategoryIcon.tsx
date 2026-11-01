import React from 'react';
import {
  Box,
  Gift,
  Grid,
  Heart,
  KeyRound,
  Layers,
  Palette,
  Sparkles,
  Star,
  Tag,
} from 'lucide-react';
import { CategoryIconName } from '../../types';

export const CATEGORY_ICON_OPTIONS: readonly {
  id: CategoryIconName;
  label: string;
}[] = [
  { id: 'tag', label: 'Tag' },
  { id: 'sparkles', label: 'Sparkles' },
  { id: 'key', label: 'Key' },
  { id: 'box', label: 'Box' },
  { id: 'gift', label: 'Gift' },
  { id: 'layers', label: 'Layers' },
  { id: 'star', label: 'Star' },
  { id: 'palette', label: 'Palette' },
  { id: 'grid', label: 'Grid' },
  { id: 'heart', label: 'Heart' },
] as const;

export const CategoryIcon: React.FC<{
  name: CategoryIconName;
  className?: string;
}> = ({ name, className = 'w-4 h-4' }) => {
  switch (name) {
    case 'sparkles':
      return <Sparkles className={className} />;
    case 'key':
      return <KeyRound className={className} />;
    case 'box':
      return <Box className={className} />;
    case 'gift':
      return <Gift className={className} />;
    case 'layers':
      return <Layers className={className} />;
    case 'star':
      return <Star className={className} />;
    case 'palette':
      return <Palette className={className} />;
    case 'grid':
      return <Grid className={className} />;
    case 'heart':
      return <Heart className={className} />;
    case 'tag':
    default:
      return <Tag className={className} />;
  }
};
