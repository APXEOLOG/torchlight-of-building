import { useEffect, useState } from "react";
import { SearchableSelect } from "@/src/components/ui/SearchableSelect";
import type {
  BaseMagnificentSupportSkill,
  BaseNobleSupportSkill,
  MagnificentSupportSkillName,
  NobleSupportSkillName,
} from "@/src/data/skill/types";
import type {
  MagnificentSupportSkillSlot,
  NobleSupportSkillSlot,
} from "@/src/lib/save-data";
import {
  findTierScaledDescription,
  formatCraftedAffix,
  getBaseDamageAffixes,
  getQualityPercentage,
  getTierRange,
  interpolateSpecialValue,
  parseValueFromCraftedAffix,
} from "@/src/lib/special-support-utils";
import {
  Modal,
  ModalActions,
  ModalButton,
  ModalDescription,
} from "../ui/Modal";

export type SpecialSupportSkill =
  | BaseMagnificentSupportSkill
  | BaseNobleSupportSkill;
export type SpecialSupportSlot =
  | MagnificentSupportSkillSlot
  | NobleSupportSkillSlot;

interface SpecialSupportEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  skill: SpecialSupportSkill;
  currentSlot: SpecialSupportSlot;
  onConfirm: (slot: SpecialSupportSlot) => void;
  skillType: "magnificent" | "noble";
}

const TIER_OPTIONS = [
  { value: 0 as const, label: "Tier 0 (Best)" },
  { value: 1 as const, label: "Tier 1" },
  { value: 2 as const, label: "Tier 2 (Worst)" },
];

const RANK_OPTIONS = [
  { value: 1 as const, label: "Rank 1" },
  { value: 2 as const, label: "Rank 2" },
  { value: 3 as const, label: "Rank 3" },
  { value: 4 as const, label: "Rank 4" },
  { value: 5 as const, label: "Rank 5" },
];

export const SpecialSupportEditModal = ({
  isOpen,
  onClose,
  skill,
  currentSlot,
  onConfirm,
  skillType,
}: SpecialSupportEditModalProps): React.ReactNode => {
  const [tier, setTier] = useState<0 | 1 | 2>(currentSlot.tier);
  const [rank, setRank] = useState<1 | 2 | 3 | 4 | 5>(currentSlot.rank);
  const [percentage, setPercentage] = useState(0);

  // Get the tier range for the skill
  const tierRange = getTierRange(skill);
  const hasTierRange = tierRange !== undefined;

  // Calculate the value from percentage
  const value = hasTierRange
    ? interpolateSpecialValue(tierRange, percentage)
    : 0;

  // Generate the crafted affix string
  const craftedAffix = formatCraftedAffix(skill, value);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setTier(currentSlot.tier);
      setRank(currentSlot.rank);
      // Calculate initial percentage from current crafted affix value
      const range = getTierRange(skill);
      if (range !== undefined) {
        const currentValue = parseValueFromCraftedAffix(
          currentSlot.craftedAffix,
        );
        setPercentage(getQualityPercentage(range, currentValue));
      } else {
        setPercentage(0);
      }
    }
  }, [isOpen, currentSlot, skill]);

  // When tier changes, reset percentage to 0 (minimum value for new tier)
  const handleTierChange = (newTier: 0 | 1 | 2): void => {
    setTier(newTier);
    setPercentage(0);
  };

  const handleConfirm = (): void => {
    const slotName =
      skillType === "magnificent"
        ? (currentSlot.name as MagnificentSupportSkillName)
        : (currentSlot.name as NobleSupportSkillName);

    const slot = {
      skillType:
        skillType === "magnificent" ? "magnificent_support" : "noble_support",
      name: slotName,
      tier,
      rank,
      craftedAffix,
      value,
    } as SpecialSupportSlot;

    onConfirm(slot);
    onClose();
  };

  // Build preview text showing the crafted affix, fixed affixes, and rank damage
  const getPreviewText = (): string => {
    const lines: string[] = [];

    // Add tier-scaled crafted affix if applicable
    if (hasTierRange && craftedAffix !== "") {
      lines.push(craftedAffix);
    }

    // Find which description index contains the tier-scaled value
    const tierScaled = findTierScaledDescription(skill);
    const tierScaledIndex = tierScaled?.index ?? -1;

    // Add fixed affixes (descriptions that are not [0] and not the tier-scaled one)
    for (let i = 1; i < skill.description.length; i++) {
      if (i !== tierScaledIndex) {
        lines.push(skill.description[i]);
      }
    }

    // Add the base additional damage every copy has, whatever its rank
    lines.push(...getBaseDamageAffixes(skill.description));

    return lines.join("\n");
  };

  const modalTitle =
    skillType === "magnificent"
      ? "Edit Magnificent Support"
      : "Edit Noble Support";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={modalTitle}
      maxWidth="md"
      dismissible={false}
    >
      <ModalDescription>{skill.name}</ModalDescription>

      <div className="space-y-4">
        {/* Tier selector */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Tier</label>
          <SearchableSelect
            value={tier}
            onChange={(val) => val !== undefined && handleTierChange(val)}
            options={TIER_OPTIONS}
            placeholder="Select tier"
          />
        </div>

        {/* Rank selector */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Rank</label>
          <SearchableSelect
            value={rank}
            onChange={(val) => val !== undefined && setRank(val)}
            options={RANK_OPTIONS}
            placeholder="Select rank"
          />
        </div>

        {/* Quality slider (only if tier range exists) */}
        {hasTierRange && (
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-sm text-zinc-400">Quality</label>
              <span className="text-sm font-medium text-zinc-50">
                {percentage}%
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={percentage}
              onChange={(e) => setPercentage(parseInt(e.target.value, 10))}
              className="w-full"
            />
            <div className="text-xs text-zinc-500 mt-1">
              Value: {value} (Range: {tierRange.min} - {tierRange.max})
            </div>
          </div>
        )}

        {/* Preview */}
        <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800">
          <div className="text-xs text-zinc-500 mb-1">Preview</div>
          <div className="text-sm text-amber-400 whitespace-pre-line">
            {getPreviewText()}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <ModalActions>
          <ModalButton onClick={handleConfirm} fullWidth>
            Confirm
          </ModalButton>
          <ModalButton onClick={onClose} variant="secondary">
            Cancel
          </ModalButton>
        </ModalActions>
      </div>
    </Modal>
  );
};
