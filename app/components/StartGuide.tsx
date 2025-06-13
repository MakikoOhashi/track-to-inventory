import React from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Badge,
} from "@shopify/polaris";
import { XIcon } from "@shopify/polaris-icons";

const steps = [
  {
    badge: "1",
    title: "Upload shipping documents",
    desc: "Upload images of your shipping documents and OCR will automatically extract the information",
    btn: "Go to upload",
    url: "/upload",
  },
  {
    badge: "2",
    title: "Review in shipments list",
    desc: "After OCR processing is complete, your shipments will automatically appear in the list",
    btn: "View shipments",
    url: "/shipments",
  },
  {
    badge: "3",
    title: "Review and edit details",
    desc: "Click on any shipment card to view and edit detailed information",
    btn: "Go to editor",
    url: "/edit",
  },
  {
    badge: "4",
    title: "Review and edit details",
    desc: "Click on any shipment card to view and edit detailed information",
    btn: "Go to editor",
    url: "/edit",
  },
];

interface StartGuideProps {
  onDismiss: () => void;
}

const StartGuide: React.FC<StartGuideProps> = ({ onDismiss }) => {
  const [isExpanded, setIsExpanded] = React.useState(true);

  return (
    <Card>
      <Box padding="400">
        <BlockStack gap="400">
          {/* Header */}
          <InlineStack align="space-between">
            <InlineStack gap="300" align="center">
              <Text as="span" variant="bodyMd">
                🚀
              </Text>
              <Text as="h3" variant="headingLg">
                Get started with inventory management
              </Text>
            </InlineStack>
            <InlineStack gap="200">
              <Button
                onClick={() => setIsExpanded((v) => !v)}
                variant="plain"
                size="slim"
              >
                {isExpanded ? "Collapse" : "Show details"}
              </Button>
              <Button
                onClick={onDismiss}
                variant="plain"
                size="slim"
                icon={XIcon}
              />
            </InlineStack>
          </InlineStack>

          {/* Steps */}
          {isExpanded && (
            <BlockStack gap="300">
              <Text as="p" variant="bodyMd" tone="subdued">
                Set up your inventory management in{" "}
                <Text as="span" fontWeight="bold">
                  3 steps
                </Text>
                :
              </Text>
              {steps.map((step) => (
                <Card key={step.badge}>
                  <Box padding="300">
                    <InlineStack gap="300" align="center">
                      <Badge>{step.badge}</Badge>
                      <BlockStack gap="100" align="start">
                        <Text
                          as="span"
                          variant="bodyMd"
                          fontWeight="semibold"
                        >
                          {step.title}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {step.desc}
                        </Text>
                        <Button
                          variant="plain"
                          size="slim"
                          url={step.url}
                        >
                          {step.btn}
                        </Button>
                      </BlockStack>
                    </InlineStack>
                  </Box>
                </Card>
              ))}

              {/* コールトゥアクション */}
              <Card>
                <Box padding="300">
                  <InlineStack gap="200" align="center">
                    <Text as="span" variant="bodyMd">
                      ✅
                    </Text>
                    <Text
                      as="span"
                      variant="bodyMd"
                      fontWeight="medium"
                      tone="success"
                    >
                      Start by uploading your first shipping document!
                    </Text>
                  </InlineStack>
                </Box>
              </Card>

              {/* フッター */}
              <Box paddingBlockStart="400">
                <InlineStack align="end">
                  <Button
                    onClick={onDismiss}
                    variant="primary"
                    size="slim"
                  >
                    Close guide
                  </Button>
                </InlineStack>
              </Box>
            </BlockStack>
          )}
        </BlockStack>
      </Box>
    </Card>
  );
};

export default StartGuide;