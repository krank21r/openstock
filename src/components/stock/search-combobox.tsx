"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Search, TrendingUp } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import type { SearchResult } from "@/lib/stock-types";

async function fetchSearch(q: string): Promise<SearchResult[]> {
  const res = await fetch(`/api/stocks/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error("Search failed");
  const json = await res.json();
  return json.results ?? [];
}

async function addToWatchlist(symbol: string) {
  const res = await fetch("/api/watchlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol }),
  });
  if (!res.ok) throw new Error("Could not add to watchlist");
  return res.json();
}

interface SearchComboboxProps {
  onSelectSymbol: (symbol: string) => void;
  watchSymbols: string[];
}

export function SearchCombobox({ onSelectSymbol, watchSymbols }: SearchComboboxProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const queryClient = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);

  const { data: results, isFetching } = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => fetchSearch(debounced),
    enabled: debounced.length > 0,
    staleTime: 60_000,
  });

  const addMutation = useMutation({
    mutationFn: addToWatchlist,
    onSuccess: (_data, symbol) => {
      queryClient.invalidateQueries({ queryKey: ["watchlist"] });
      toast({ title: "Added to watchlist", description: symbol });
    },
    onError: () => {
      toast({ title: "Error", description: "Could not add to watchlist", variant: "destructive" });
    },
  });

  const pick = (symbol: string) => {
    setOpen(false);
    setInput("");
    setDebounced("");
    onSelectSymbol(symbol);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Search stocks"
          className="h-9 w-full justify-start px-3 text-muted-foreground sm:w-72 md:w-80"
        >
          <Search className="size-4 shrink-0 opacity-60" aria-hidden />
          <span className="truncate">Search stocks… (e.g. AAPL, Tesla)</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-0 sm:w-[400px]">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search symbol or company…"
            value={input}
            onValueChange={setInput}
          />
          <CommandList>
            {debounced.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                Type a ticker or company name
              </div>
            )}
            {debounced.length > 0 && isFetching && (results === undefined) && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Searching…
              </div>
            )}
            {debounced.length > 0 && !isFetching && (results?.length ?? 0) === 0 && (
              <CommandEmpty>No matches for “{debounced}”</CommandEmpty>
            )}
            {(results?.length ?? 0) > 0 && (
              <CommandGroup heading="Results">
                {results?.map((r) => {
                  const watched = watchSymbols.includes(r.symbol);
                  return (
                    <CommandItem
                      key={`${r.symbol}-${r.exchange}`}
                      value={r.symbol}
                      onSelect={() => pick(r.symbol)}
                      className="gap-3 aria-selected:bg-accent"
                    >
                      <TrendingUp className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{r.symbol}</span>
                          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                            {r.type}
                          </span>
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{r.name}</div>
                      </div>
                      <Button
                        size="sm"
                        variant={watched ? "secondary" : "outline"}
                        disabled={watched || addMutation.isPending}
                        aria-label={watched ? `${r.symbol} already in watchlist` : `Add ${r.symbol} to watchlist`}
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          addMutation.mutate(r.symbol);
                        }}
                      >
                        {watched ? (
                          "Added"
                        ) : (
                          <>
                            <Plus className="size-3" aria-hidden /> Add
                          </>
                        )}
                      </Button>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
